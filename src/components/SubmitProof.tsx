// =============================================================================
// Zone Rush — Submit Proof Component
// Full-screen overlay for photo/video submission with GPS capture.
//
// CHANGES (this version):
// - Added optional resolvedTask + stepChoices props for sequential (CYOA) cards.
//   When present, the challenge.description passed in is already the RESOLVED
//   task, and these two get stamped onto the submission. Standard cards omit
//   them entirely (conditional spreads — never write undefined to Firestore).
//
// CHANGES (prior):
// - Uses the shared useLocation hook instead of its own getCurrentPosition.
// - Hard submission gate: cannot submit unless GPS is good or low_accuracy.
// - On submit, calls refresh() to grab a FRESH fix at the moment of submit,
//   not the stale one from when the user opened the modal.
// - Clear UI block when GPS is missing/denied/stale, with troubleshooting.
// =============================================================================

import { useState, useRef, useEffect } from 'react'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { collection, addDoc, getDocs, serverTimestamp } from 'firebase/firestore'
import { db, storage, auth } from '../lib/firebase'
import { detectZone } from '../lib/geo'
import { validateSubmissionZone } from '../lib/scoring'
import { useLocation, isLocationSubmittable, locationStatusLabel } from '../hooks/useLocation'

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

  // --- Sequential cards only (absent for standard cards) ---
  // When present, the `challenge.description` passed in is already the RESOLVED
  // task; these two get stamped onto the submission so the GM and exports see
  // both the resolved task and the locked choices that produced it.
  resolvedTask?: string
  stepChoices?: string[]

  onClose: () => void
  onSubmitted: () => void
}

export default function SubmitProof({
  gameId, teamId, challenge, closedZones, resolvedTask, stepChoices, onClose, onSubmitted,
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
  const [zonesLoaded, setZonesLoaded] = useState(false)
  const [zonesError, setZonesError] = useState(false)

  // Shared location hook — same source as the pill in the top bar
  const location = useLocation()

// Load zones from Firestore.
  // We track zonesLoaded separately so the Submit button can be gated on it —
  // submitting before zones finish loading would write zone_id: null (C7 fix).
  useEffect(() => {
    async function loadZones() {
      try {
        const snapshot = await getDocs(collection(db, 'zones'))
        const loaded = snapshot.docs.map((d) => {
          const data = d.data()
          return { id: d.id, ...data, boundary: typeof data.boundary === 'string' ? JSON.parse(data.boundary) : data.boundary }
        })
        setZones(loaded)
        setZonesLoaded(true)
      } catch (err) {
        console.error('Failed to load zones:', err)
        setZonesError(true)
      }
    }
    loadZones()
  }, [])

const detectedZoneId = detectZone(location.lat, location.lng, zones)
  const isZoneClosed = !!detectedZoneId && closedZones.includes(detectedZoneId)
  const canSubmitWithLocation = isLocationSubmittable(location)

  // Single source of truth for whether the Submit button is live.
  // Must have a file, not be mid-upload, have a usable GPS fix, AND have zones loaded.
  const canSubmit = !!file && !uploading && canSubmitWithLocation && zonesLoaded

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

    // Safety net behind the disabled button: never submit before zones load,
    // or zone_id would be written as null (C7).
    if (!zonesLoaded) {
      setError('Game zones haven\'t loaded yet. Wait a moment and try again.')
      return
    }

    setError(null)
    setUploading(true)

    try {
      // Re-acquire a FRESH fix at the moment of submit. This is the key fix
      // for "I opened the modal, walked 100m, took a photo, then submitted."
      const fresh = await location.refresh()

      if (!isLocationSubmittable(fresh)) {
        setError(
          fresh.status === 'denied'
            ? 'Location is off. Re-enable location access and try again.'
            : `Couldn't get your location (${locationStatusLabel(fresh.status)}). Step outside or walk a few feet, then try again.`
        )
        setUploading(false)
        return
      }

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

      const submitZoneId = detectZone(fresh.lat, fresh.lng, zones)
      const submitZone = zones.find((z) => z.id === submitZoneId) ?? null
      const inZone =
        fresh.lat !== null && fresh.lng !== null && submitZone !== null
          ? validateSubmissionZone(fresh.lat, fresh.lng, submitZone)
          : false

      await addDoc(collection(db, 'submissions'), {
        game_id: gameId,
        team_id: teamId,
        challenge_id: challenge.id,
        challenge_description: challenge.description,
        challenge_difficulty: challenge.difficulty,
        // Sequential-card fields — only present when this came from a CYOA card.
        // Conditional spreads so standard cards omit the keys entirely
        // (Firestore rejects `undefined`).
        ...(resolvedTask ? { resolved_task: resolvedTask } : {}),
        ...(stepChoices ? { step_choices: stepChoices } : {}),
        zone_id: submitZoneId,
        submitted_by: user.uid,
        media_url: downloadURL,
        media_type: mediaType,
        gps_lat: fresh.lat,
        gps_lng: fresh.lng,
        gps_accuracy: fresh.accuracy,           // NEW — surfaces accuracy in GM dashboard
        gps_captured_at: fresh.timestamp,        // NEW — proves freshness
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

        {/* GPS status — prominent, with refresh button if not good */}
        <div
          style={{
            background: canSubmitWithLocation
              ? 'rgba(6,214,160,0.06)'
              : 'rgba(239,71,111,0.06)',
            border: `1px solid ${canSubmitWithLocation ? 'rgba(6,214,160,0.25)' : 'rgba(239,71,111,0.25)'}`,
            borderRadius: 10,
            padding: '12px 14px',
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: canSubmitWithLocation ? 0 : 8 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: canSubmitWithLocation ? '#06D6A0' : '#EF476F',
                flexShrink: 0,
              }}
            />
            <p style={{ color: canSubmitWithLocation ? '#06D6A0' : '#EF476F', fontWeight: 700, fontSize: '0.85rem', margin: 0 }}>
              {locationStatusLabel(location.status)}
              {location.accuracy != null && canSubmitWithLocation && (
                <span style={{ color: '#666', fontFamily: "'JetBrains Mono', monospace", fontWeight: 400, marginLeft: 8 }}>
                  ±{Math.round(location.accuracy)}m
                </span>
              )}
            </p>
          </div>
          {!canSubmitWithLocation && (
            <>
              <p style={{ color: '#888', fontSize: '0.78rem', lineHeight: 1.5, marginBottom: 10 }}>
                {location.status === 'denied'
                  ? 'Location access is denied. Re-enable it in your browser/phone settings, then reload this page.'
                  : location.status === 'acquiring' || location.status === 'prompt'
                  ? 'Waiting for your first GPS fix. This can take 10–30 seconds.'
                  : 'Your location can\'t be confirmed. Step outside, away from tall buildings, then tap below.'}
              </p>
              <button
                onClick={() => location.refresh()}
                style={{
                  background: 'rgba(255,209,102,0.12)',
                  border: '1px solid rgba(255,209,102,0.3)',
                  color: '#FFD166',
                  padding: '8px 14px',
                  borderRadius: 8,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                🔄 Try again
              </button>
            </>
          )}
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

        {/* Zones still loading — submit is gated until this resolves */}
        {canSubmitWithLocation && !zonesLoaded && !zonesError && (
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid #222',
            borderRadius: 10, padding: '12px 16px', marginBottom: 20,
            display: 'flex', gap: 10, alignItems: 'center',
          }}>
            <span style={{ fontSize: '1rem', flexShrink: 0 }}>⏳</span>
            <p style={{ color: '#888', fontSize: '0.8rem', lineHeight: 1.5, margin: 0 }}>
              Loading game zones…
            </p>
          </div>
        )}

        {/* Zone load failed — can't safely tag a submission without zones */}
        {zonesError && (
          <div style={{
            background: 'rgba(239,71,111,0.06)', border: '1px solid rgba(239,71,111,0.25)',
            borderRadius: 10, padding: '12px 16px', marginBottom: 20,
            display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <span style={{ fontSize: '1rem', flexShrink: 0 }}>⚠️</span>
            <div>
              <p style={{ color: '#EF476F', fontWeight: 700, fontSize: '0.82rem', marginBottom: 3 }}>
                Couldn't load game zones
              </p>
              <p style={{ color: '#888', fontSize: '0.78rem', lineHeight: 1.5 }}>
                Reload the page and try again. If it keeps happening, tell the GM.
              </p>
            </div>
          </div>
        )}

        {/* Out-of-zone warning — only meaningful once zones have actually loaded */}
        {canSubmitWithLocation && zonesLoaded && !detectedZoneId && (
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

        {/* Submit button — DISABLED if no GPS */}
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
            disabled={!canSubmit}
            style={{
              width: '100%',
              background: !canSubmit ? '#1a1a1a' : 'rgba(6,214,160,0.15)',
              border: `1px solid ${!canSubmit ? '#222' : 'rgba(6,214,160,0.3)'}`,
              color: !canSubmit ? '#444' : '#06D6A0',
              padding: '14px 20px',
              borderRadius: 10,
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: !canSubmit ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {uploading
              ? 'Submitting...'
              : !canSubmitWithLocation
              ? '📍 Waiting for location'
              : !zonesLoaded
              ? 'Loading zones…'
              : !file
              ? 'Add a photo or video first'
              : 'Submit for GM Review'}
          </button>
        )}
      </div>
    </div>
  )
}