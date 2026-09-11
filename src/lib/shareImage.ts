// =============================================================================
// Foray — Share a rendered image (recap cards)
//
// Hands one or more PNG blobs to the phone's share sheet (where "Save Image"
// is one of the options), or downloads them on browsers that can't share
// files. Used by the recap card and the zone map card.
// =============================================================================

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled'

export interface ShareableImage {
  blob: Blob
  filename: string
}

export function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'foray'
}

function download(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function shareImages(images: ShareableImage[], title: string): Promise<ShareOutcome> {
  const files = images.map((i) => new File([i.blob], i.filename, { type: 'image/png' }))
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.share && nav.canShare?.({ files })) {
    try {
      await nav.share({ files, title })
      return 'shared'
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'cancelled'
      // Some browsers advertise file sharing then refuse — fall through.
    }
  }
  // Browsers throttle multiple programmatic downloads; space them out.
  for (let i = 0; i < files.length; i++) {
    setTimeout(() => download(files[i]), i * 400)
  }
  return 'downloaded'
}
