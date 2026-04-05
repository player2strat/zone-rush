// =============================================================================
// Zone Rush — Submit Proof Component
// Full-screen overlay for photo/video submission with GPS capture
//
// CHANGES:
// - Removed phone-free bonus toggle (removed from alpha)
// =============================================================================

import { useState, useRef, useEffect } from 'react'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { collection, addDoc, getDocs, serverTimestamp } from 'firebase/firestore'
import { db, storage, auth } from '../lib/firebase'
import { detectZone } from '../lib/geo'
import { validateSubmissionZone } from '../lib/scoring'

interface SubmitProofProps {
  gameId: string
  teamId: string
  challenge: {
    id: string
    description: string
    difficulty: string
    points: number
    verification_type: string
    tier2: { description: string; bonus_points: number } | null
    phone_free_eligible: boolean
    is_time_based: boolean
  }
  closedZones: string[]
  onClose: () => void
  onSubmitted: () => void
}

export default function SubmitProof({
  gameId, teamId, challenge, closedZones, onClose, onSubmitted,
}: SubmitProofProps) {
  const user = auth.currentUser
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [attemptTier2, setAttemptTier2] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [zones, setZones] = useState<any[]>([])
  const [gpsLat, setGpsLat] = useState<number | null>(null)
  const [gpsLng, setGpsLng] = useState<number | null>(null)
  const [gpsStatus, setGpsStatus] = useState<'loading' | 'success' | 'error'>('loading')

  // Load zones from Firestore
  useEffect(() => {
    async function loadZones() {
      const snapshot = await getDocs(collection(db, 'zones'))
      const loaded = snapshot.docs.map((d) => {
        const data = d.data()
        return { id: d.id, ...data, boundary: typeof data.boundary === 'string' ? JSON.parse(data.boundary) : data.boundary }
      })
      setZones(loaded)
    }
    loadZones()
  }, [])

  // Capture GPS on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsStatus('error')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLat(pos.coords.latitude)
        setGpsLng(pos.coords.longitude)
        setGpsStatus('success')
      },
      () => setGpsStatus('error'),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }, [])

  const detectedZoneId = detectZone(gpsLat, gpsLng, zones)
  const isZoneClosed = !!detectedZoneId && closedZones.includes(detectedZoneId)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (!selected) return
    setFile(selected)
    setError(null)
    setPreview(URL.createObjectURL(selected))
  }

  const getMediaType = (f: File): 'photo' | 'video' | 'audio' => {
    if (f.type.startsWith('video/')) return 'video'
    if (f.type.startsWith('audio/')) return 'audio'
    return 'photo'
  }

  const handleSubmit = async () => {
    if (!file || !user) return
    setUploading(true)
    setError(null)

    try {
      const timestamp = Date.now()
      const mediaType = getMediaType(file)
      const ext = file.name.split('.').pop() || 'jpg'
      const storagePath = `submissions/${gameId}/${teamId}/${challenge.id}_${timestamp}.${ext}`
      const storageRef = ref(storage, storagePath)
      const uploadTask = uploadBytesResumable(storageRef, file)

      const downloadURL: string = await new Promise((resolve, reject) => {
        uploadTask.on(
          'state_changed',
          (snapshot) => {
            setUploadProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100))
          },
          (err) => reject(err),
          async () => {
            const url = await getDownloadURL(uploadTask.snapshot.ref)
            resolve(url)
          }
        )
      })

      const detectedZoneId = detectZone(gpsLat, gpsLng, zones)
      const detectedZone = zones.find((z) => z.id === detectedZoneId) ?? null
      const inZone = gpsLat !== null && gpsLng !== null && detectedZone !== null
        ? validateSubmissionZone(gpsLat, gpsLng, detectedZone)
        : false

      await addDoc(collection(db, 'submissions'), {
        game_id: gameId,
        team_id: teamId,
        challenge_id: challenge.id,
        challenge_description: challenge.description,
        challenge_difficulty: challenge.difficulty,
        zone_id: detectZone(gpsLat, gpsLng, zones),
        submitted_by: user.uid,
        media_url: downloadURL,
        media_type: mediaType,
        gps_lat: gpsLat,
        gps_lng: gpsLng,
        in_zone: inZone,
        status: 'pending',
        gm_notes: '',
        reviewed_by: null,
        reviewed_at: null,
        attempted_tier2: attemptTier2,
        tier2_approved: false,
        phone_free_claimed: false,
        submitted_at: serverTimestamp(),
      })

      setSubmitted(true)
      onSubmitted()
    } catch (err: any) {
      console.error('Submission failed:', err)
      setError(err.message || 'Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  // ---- Success screen ----
  if (submitted) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#0a0a0a', zIndex: 200,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", padding: 24,
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: 'rgba(6,214,160,0.15)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', marginBottom: 20,
        }}>
          <span style={{ fontSize: '1.8rem' }}>✓</span>
        </div>
        <h2 style={{ color: '#06D6A0', fontWeight: 700, marginBottom: 8 }}>Submitted!</h2>
        <p style={{ color: '#888', fontSize: '0.9rem', textAlign: 'center', marginBottom: 24 }}>
          Your proof is pending GM review. You'll see the status update on your card.
        </p>
        <button onClick={onClose} style={{
          background: 'rgba(6,214,160,0.15)', border: '1px solid rgba(6,214,160,0.3)',
          color: '#06D6A0', padding: '12px 32px', borderRadius: 8,
          fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}>
          Back to Hand
        </button>
      </div>
    )
  }

  // ---- Main submission screen ----
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#0a0a0a', zIndex: 200,
      display: 'flex', flexDirection: 'column',
      fontFamily: "'DM Sans', sans-serif", color: '#fff',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid #1a1a1a',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
      }}>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#888',
          fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'inherit', padding: '4px 0',
        }}>
          ← Back
        </button>
        <span style={{ fontSize: '0.75rem', color: '#555', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
          Submit Proof
        </span>
        <div style={{ width: 50 }} />
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 20px 40px' }}>
        {/* Challenge reminder */}
        <div style={{
          background: 'rgba(255,255,255,0.03)', border: '1px solid #1a1a1a',
          borderRadius: 10, padding: '14px 16px', marginBottom: 20,
        }}>
          <p style={{ color: '#888', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Challenge
          </p>
          <p style={{ color: '#e0e0e0', fontSize: '0.9rem', lineHeight: 1.6 }}>
            {challenge.description}
          </p>
        </div>

        {/* File picker */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*"
          capture="environment"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        {!file ? (
          <div style={{ display: 'grid', gap: 10, marginBottom: 20 }}>
            <button
              onClick={() => {
                if (fileInputRef.current) {
                  fileInputRef.current.setAttribute('capture', 'environment')
                  fileInputRef.current.click()
                }
              }}
              style={{
                background: 'rgba(255,209,102,0.08)', border: '1px solid rgba(255,209,102,0.2)',
                borderRadius: 10, padding: '24px 20px', cursor: 'pointer',
                fontFamily: 'inherit', textAlign: 'center',
              }}
            >
              <span style={{ fontSize: '1.8rem', display: 'block', marginBottom: 8 }}>📷</span>
              <span style={{ color: '#FFD166', fontWeight: 600, fontSize: '0.9rem' }}>Take Photo / Video</span>
              <span style={{ color: '#555', fontSize: '0.78rem', display: 'block', marginTop: 4 }}>Opens your camera</span>
            </button>

            <button
              onClick={() => {
                if (fileInputRef.current) {
                  fileInputRef.current.removeAttribute('capture')
                  fileInputRef.current.click()
                }
              }}
              style={{
                background: 'rgba(255,255,255,0.03)', border: '1px solid #222',
                borderRadius: 10, padding: '16px 20px', cursor: 'pointer',
                fontFamily: 'inherit', textAlign: 'center',
              }}
            >
              <span style={{ color: '#888', fontWeight: 600, fontSize: '0.85rem' }}>Choose from Gallery</span>
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 20 }}>
            {file.type.startsWith('video/') ? (
              <video src={preview || ''} controls style={{ width: '100%', borderRadius: 10, maxHeight: 140, background: '#111', objectFit: 'contain' }} />
            ) : file.type.startsWith('audio/') ? (
              <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 20, textAlign: 'center' }}>
                <span style={{ fontSize: '2rem' }}>🎙️</span>
                <audio src={preview || ''} controls style={{ width: '100%', marginTop: 12 }} />
              </div>
            ) : (
              <img src={preview || ''} alt="Preview" style={{ width: '100%', borderRadius: 10, maxHeight: 140, objectFit: 'contain', background: '#111' }} />
            )}
            <button
              onClick={() => { setFile(null); setPreview(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
              style={{ background: 'none', border: 'none', color: '#666', fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit', marginTop: 8, padding: 0 }}
            >
              ✕ Remove and pick again
            </button>
          </div>
        )}

        {/* GPS status */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: gpsStatus === 'success' && !detectedZoneId ? 10 : 20,
          fontSize: '0.8rem',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: gpsStatus === 'success' ? '#06D6A0' : gpsStatus === 'error' ? '#EF476F' : '#FFD166',
          }} />
          <span style={{ color: '#888' }}>
            {gpsStatus === 'success'
              ? `GPS captured (${gpsLat?.toFixed(4)}, ${gpsLng?.toFixed(4)})`
              : gpsStatus === 'error'
              ? 'GPS unavailable — submission still allowed'
              : 'Getting your location...'}
          </span>
        </div>

        {/* Out-of-zone warning */}
        {gpsStatus === 'success' && !detectedZoneId && (
          <div style={{
            background: 'rgba(255,209,102,0.08)', border: '1px solid rgba(255,209,102,0.25)',
            borderRadius: 10, padding: '12px 16px', marginBottom: 20,
            display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <span style={{ fontSize: '1rem', flexShrink: 0 }}>⚠️</span>
            <div>
              <p style={{ color: '#FFD166', fontWeight: 700, fontSize: '0.82rem', marginBottom: 3 }}>
                You appear to be outside an active zone
              </p>
              <p style={{ color: '#888', fontSize: '0.78rem', lineHeight: 1.5 }}>
                Make sure you're in one of the game zones before submitting.
                The GM will see your location — submissions from outside zones may be rejected.
              </p>
            </div>
          </div>
        )}

        {/* Tier 2 toggle */}
        {challenge.tier2 && (
          <button
            onClick={() => setAttemptTier2(!attemptTier2)}
            style={{
              width: '100%', textAlign: 'left',
              background: attemptTier2 ? 'rgba(155,93,229,0.08)' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${attemptTier2 ? 'rgba(155,93,229,0.3)' : '#1a1a1a'}`,
              borderRadius: 10, padding: '14px 16px', marginBottom: 20,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 20, height: 20, borderRadius: 4,
                border: `2px solid ${attemptTier2 ? '#9B5DE5' : '#333'}`,
                background: attemptTier2 ? 'rgba(155,93,229,0.2)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {attemptTier2 && <span style={{ color: '#9B5DE5', fontSize: '0.65rem', fontWeight: 800 }}>✓</span>}
              </div>
              <div>
                <p style={{ color: attemptTier2 ? '#9B5DE5' : '#888', fontWeight: 600, fontSize: '0.85rem' }}>
                  Tier 2 Bonus (+{challenge.tier2.bonus_points}pt)
                </p>
                <p style={{ color: '#555', fontSize: '0.78rem', marginTop: 2 }}>
                  {challenge.tier2.description}
                </p>
              </div>
            </div>
          </button>
        )}

        {/* Error message */}
        {error && (
          <p style={{
            color: '#EF476F', fontSize: '0.82rem',
            background: 'rgba(239,71,111,0.08)', border: '1px solid rgba(239,71,111,0.2)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 16,
          }}>
            {error}
          </p>
        )}

        {/* Upload progress */}
        {uploading && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${uploadProgress}%`,
                background: 'linear-gradient(90deg, #06D6A0, #118AB2)',
                borderRadius: 3, transition: 'width 0.2s',
              }} />
            </div>
            <p style={{ fontSize: '0.78rem', color: '#888', textAlign: 'center', marginTop: 6 }}>
              Uploading... {uploadProgress}%
            </p>
          </div>
        )}

        {/* Submit button */}
        {isZoneClosed ? (
          <div style={{
            background: 'rgba(239,71,111,0.08)', border: '1px solid rgba(239,71,111,0.2)',
            borderRadius: 10, padding: '16px 20px', textAlign: 'center',
          }}>
            <p style={{ color: '#EF476F', fontWeight: 700, fontSize: '0.9rem', marginBottom: 4 }}>
              🔒 Zone Closed
            </p>
            <p style={{ color: '#888', fontSize: '0.82rem' }}>
              {detectedZoneId?.replace('zone_district_', 'District ')} is no longer accepting submissions.
              Points and claims already earned here are kept.
            </p>
          </div>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!file || uploading}
            style={{
              width: '100%',
              background: !file || uploading ? '#1a1a1a' : 'rgba(6,214,160,0.15)',
              border: `1px solid ${!file || uploading ? '#222' : 'rgba(6,214,160,0.3)'}`,
              color: !file || uploading ? '#444' : '#06D6A0',
              padding: '14px 20px', borderRadius: 10,
              fontSize: '0.95rem', fontWeight: 700,
              cursor: !file || uploading ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {uploading ? 'Submitting...' : 'Submit for GM Review'}
          </button>
        )}
      </div>
    </div>
  )
}