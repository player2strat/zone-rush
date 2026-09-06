// =============================================================================
// Foray — Client-side photo compression
//
// Phone cameras produce 4–8 MB JPEGs. On a weak cell signal that is the
// slowest, flakiest moment of the game, and the GM never needs more than a
// screen's worth of pixels to judge a photo. So before upload we redraw the
// image onto a canvas capped at MAX_EDGE pixels and re-encode as JPEG.
//
// Safe by construction: anything that isn't a still image, anything the
// browser can't decode (rare HEIC edge cases), or any error at all falls back
// to the original file untouched. Videos and audio are never touched.
// =============================================================================

export const MAX_EDGE = 1600
export const JPEG_QUALITY = 0.82

/** True for still images we can safely re-encode (skips GIF to keep animation). */
export function isCompressibleImage(file: File): boolean {
  return file.type.startsWith('image/') && file.type !== 'image/gif'
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap honours EXIF orientation with `imageOrientation`, so a
  // portrait phone photo doesn't come out sideways.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Image decode failed'))
      img.src = url
    })
  } finally {
    // Revoke after the image has been drawn; caller draws synchronously after
    // await, so a short deferral is enough.
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}

/**
 * Downscale a photo for upload. Returns a new JPEG File, or the original file
 * when compression is not applicable or not beneficial.
 */
export async function compressImage(file: File): Promise<File> {
  if (!isCompressibleImage(file)) return file

  try {
    const source = await decode(file)
    const srcW = 'naturalWidth' in source ? source.naturalWidth : source.width
    const srcH = 'naturalHeight' in source ? source.naturalHeight : source.height
    if (!srcW || !srcH) return file

    const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH))
    const w = Math.round(srcW * scale)
    const h = Math.round(srcH * scale)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(source, 0, 0, w, h)
    if ('close' in source) source.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    )
    if (!blob || blob.size === 0) return file

    // Only swap if we actually saved something. A small, already-JPEG photo
    // can come out slightly larger after re-encoding.
    if (blob.size >= file.size) return file

    const base = file.name.replace(/\.[^.]+$/, '') || 'photo'
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
  } catch (err) {
    console.warn('Photo compression skipped:', err)
    return file
  }
}
