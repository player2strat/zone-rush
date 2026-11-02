// =============================================================================
// Foray — GM alerts
//
// What tells a GM something new is waiting in one of their games: a short
// chime and a desktop pop-up (components/RunningGamesProvider decides when).
// Both only work while Foray is open in a browser tab, even a background one.
// Alerts with the browser closed need push notifications, which come with the
// phone work on ROADMAP.md.
//
// The on/off switches are kept per browser (localStorage): they're about this
// device, and a blocked or empty storage just means the defaults (both on).
// =============================================================================

const SOUND_KEY = 'foray.gmAlerts.sound'
const POPUPS_KEY = 'foray.gmAlerts.popups'

function readPref(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'off'
  } catch {
    return true
  }
}

function writePref(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? 'on' : 'off')
  } catch {
    /* storage blocked: the switch just won't stick */
  }
}

export const soundOn = () => readPref(SOUND_KEY)
export const setSoundOn = (on: boolean) => writePref(SOUND_KEY, on)

// 'ask' = the browser hasn't been asked for permission yet.
export type PopupState = 'unsupported' | 'blocked' | 'ask' | 'on' | 'off'

export function popupState(): PopupState {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  if (Notification.permission === 'default') return 'ask'
  return readPref(POPUPS_KEY) ? 'on' : 'off'
}

export const setPopupsOn = (on: boolean) => writePref(POPUPS_KEY, on)

/** Ask the browser for permission (shows its own prompt), then turn pop-ups on. */
export async function requestPopups(): Promise<PopupState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    await Notification.requestPermission()
  } catch {
    /* older browsers: the callback form, or no prompt at all */
  }
  setPopupsOn(true)
  return popupState()
}

// ---------------------------------------------------------------------------
// Chime. Built with Web Audio, so there's no sound file to load. Browsers only
// allow sound after the page has been clicked, so primeChime() runs on the
// GM's first click and later chimes can play from the background.
// ---------------------------------------------------------------------------
let audio: AudioContext | null = null
let lastChime = 0

export function primeChime() {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') audio.resume().catch(() => {})
  } catch {
    /* no Web Audio in this browser */
  }
}

/** A short two-note chime, at most one every few seconds so a burst stays one sound. */
export function playChime() {
  if (!soundOn()) return
  const now = Date.now()
  if (now - lastChime < 3000) return
  lastChime = now
  primeChime()
  if (!audio) return
  const t = audio.currentTime
  ;[880, 1320].forEach((freq, i) => {
    const osc = audio!.createOscillator()
    const gain = audio!.createGain()
    const start = t + i * 0.15
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3)
    osc.connect(gain).connect(audio!.destination)
    osc.start(start)
    osc.stop(start + 0.32)
  })
}

/** A desktop pop-up. Clicking it brings Foray forward and runs onClick. */
export function showPopup(title: string, body: string, tag: string, onClick: () => void) {
  if (popupState() !== 'on') return
  try {
    const popup = new Notification(title, { body, tag, icon: '/icon-192.png' })
    popup.onclick = () => {
      window.focus()
      onClick()
      popup.close()
    }
  } catch {
    /* some mobile browsers only allow pop-ups from a service worker */
  }
}
