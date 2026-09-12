// =============================================================================
// Foray — server-side Firebase (Vercel functions only; never imported by the app)
//
// Environment variables (set in Vercel → Project → Settings → Environment
// Variables; for local `vercel dev` put them in .env.local without the VITE_
// prefix):
//
//   FIREBASE_SERVICE_ACCOUNT   JSON of a service-account key (Firebase console
//                              → Project settings → Service accounts → Generate
//                              new private key). Paste the whole JSON as one line.
//   FIREBASE_STORAGE_BUCKET    e.g. zonerush-9f2db.firebasestorage.app (optional;
//                              finished reels are copied here when set)
//   CREATOMATE_API_KEY         from creatomate.com → project → API keys
//   CREATOMATE_TEMPLATE_ID     optional; when set, renders use this template
//                              instead of the code-built composition
//   REEL_MUSIC_URL             public URL of the licensed music track (mp3)
//   REEL_WEBHOOK_SECRET        any long random string; Creatomate calls back
//                              with it so nobody else can spoof completions
//   RESEND_API_KEY             from resend.com (optional; no key = no email)
//   REEL_FROM_EMAIL            e.g. "Foray <reels@foray.city>" — a verified domain
//   REEL_MOCK                  "1" = skip Creatomate and mark reels ready with a
//                              sample video, for testing the flow end to end
// =============================================================================

import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

let app: App | null = null

export function adminApp(): App {
  if (app) return app
  if (getApps().length) { app = getApps()[0]; return app }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set')
  const creds = JSON.parse(raw)
  app = initializeApp({
    credential: cert(creds),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
  })
  return app
}

export const adminDb = () => getFirestore(adminApp())
export const adminAuth = () => getAuth(adminApp())
export const adminStorage = () => getStorage(adminApp())

/** Verifies the Firebase ID token in `Authorization: Bearer …` and returns the uid. */
export async function requireUser(authHeader: string | undefined): Promise<string> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) throw Object.assign(new Error('Missing auth token'), { status: 401 })
  try {
    const decoded = await adminAuth().verifyIdToken(token)
    return decoded.uid
  } catch {
    throw Object.assign(new Error('Invalid auth token'), { status: 401 })
  }
}

/** Same as requireUser, plus the users/{uid} doc must carry role gm or admin. */
export async function requireGm(authHeader: string | undefined): Promise<string> {
  const uid = await requireUser(authHeader)
  const snap = await adminDb().doc(`users/${uid}`).get()
  const role = snap.exists ? (snap.data()?.role as string) : 'player'
  if (role !== 'gm' && role !== 'admin') {
    throw Object.assign(new Error('Game Masters only'), { status: 403 })
  }
  return uid
}

export function errorStatus(err: unknown): number {
  return (err as { status?: number })?.status ?? 500
}
