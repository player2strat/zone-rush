// =============================================================================
// Zone Rush — Create Game Page
// GM configures a new game: selects zones, sets duration/team size, gets a code.
// All settings stored in Firestore game doc — never hardcoded.
// =============================================================================

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, doc, setDoc, query, where } from 'firebase/firestore'
import { db, auth } from '../lib/firebase'

interface ZoneDoc {
  id: string
  name: string
  district_number: number
  city: string
}

// Generate a random 6-character join code (uppercase letters + numbers)
function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/1/O/0 to avoid confusion
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export default function CreateGame() {
  const navigate = useNavigate()
  const user = auth.currentUser

  // Zone selection
  const [zones, setZones] = useState<ZoneDoc[]>([])
  const [selectedZones, setSelectedZones] = useState<string[]>([])
  const [loadingZones, setLoadingZones] = useState(true)
  const [cityFilter, setCityFilter] = useState('nyc')

  // Zone closure schedule — maps zone_id → minutes into game when it closes
  // Empty string means "never closes"
  const [zoneCloseMinutes, setZoneCloseMinutes] = useState<Record<string, string>>({})
  const [showClosureSchedule, setShowClosureSchedule] = useState(false)

  // Game settings — all configurable, stored in Firestore
  const [gameName, setGameName] = useState('')
  const [maxTeams, setMaxTeams] = useState(3)
  const [teamSize, setTeamSize] = useState(3)
  const [durationMinutes, setDurationMinutes] = useState(180)
  const [claimThreshold, setClaimThreshold] = useState(6)
  const [zoneBonusPoints, setZoneBonusPoints] = useState(3)
  const [discardLimit, setDiscardLimit] = useState(1)
  const [handSize, setHandSize] = useState(6)

  // State
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  // Load available zones from Firestore
  useEffect(() => {
    async function loadZones() {
      try {
        const q = query(collection(db, 'zones'), where('city', '==', cityFilter))
        const snapshot = await getDocs(q)
        const zoneDocs: ZoneDoc[] = []
        snapshot.forEach((doc) => {
          const data = doc.data()
          zoneDocs.push({
            id: doc.id,
            name: data.name,
            district_number: data.district_number,
            city: data.city,
          })
        })
        zoneDocs.sort((a, b) => a.district_number - b.district_number)
        setZones(zoneDocs)
        setSelectedZones(zoneDocs.map((z) => z.id))
      } catch (err: any) {
        setError('Failed to load zones: ' + err.message)
      }
      setLoadingZones(false)
    }
    loadZones()
  }, [cityFilter])

  const toggleZone = (zoneId: string) => {
    setSelectedZones((prev) =>
      prev.includes(zoneId)
        ? prev.filter((id) => id !== zoneId)
        : [...prev, zoneId]
    )
  }

  // Build the zone_close_schedule array for Firestore
  // Only includes zones that have a close time set
  const buildCloseSchedule = () => {
    const schedule: { zone_id: string; close_at_minutes: number }[] = []
    for (const [zoneId, val] of Object.entries(zoneCloseMinutes)) {
      const mins = parseInt(val)
      if (!isNaN(mins) && mins > 0 && selectedZones.includes(zoneId)) {
        schedule.push({ zone_id: zoneId, close_at_minutes: mins })
      }
    }
    return schedule
  }

  const handleCreateGame = async () => {
    if (!user) return
    if (selectedZones.length === 0) {
      setError('Select at least one zone')
      return
    }
    if (!gameName.trim()) {
      setError('Give your game a name')
      return
    }

    setCreating(true)
    setError('')

    try {
      const joinCode = generateJoinCode()
      const gameId = 'game_' + Date.now()
      const closeSchedule = buildCloseSchedule()

      await setDoc(doc(db, 'games', gameId), {
        id: gameId,
        name: gameName.trim(),
        city: 'nyc',
        status: 'lobby',
        created_by: user.uid,
        join_code: joinCode,
        max_teams: maxTeams,
        zones: selectedZones,
        closed_zones: [], // zones that have been auto-closed during the game
        started_at: null,
        ends_at: null,
        created_at: new Date(),

        // All game settings — configurable, never hardcoded in game logic
        settings: {
          team_size: teamSize,
          duration_minutes: durationMinutes,
          claim_threshold: claimThreshold,
          zone_bonus_points: zoneBonusPoints,
          discard_limit: discardLimit,
          hand_size: handSize,
          strategy_period_minutes: 5,
          points_easy: 1,
          points_medium: 3,
          points_hard: 5,
          tier2_bonus: 1,
          phone_free_bonus: 1,
          phone_free_no_talk_bonus: 2,
          most_zones_bonus: 1,
          fastest_return_bonus: 1,
          hydration_bonus: 1,
          transport_mode_bonus: 1,
          // Zone closure schedule — array of { zone_id, close_at_minutes }
          // Empty array means no zones are scheduled to close
          zone_close_schedule: closeSchedule,
        },
      })

      // Navigate to the lobby for this game
      navigate('/lobby/' + gameId)
    } catch (err: any) {
      setError('Failed to create game: ' + err.message)
      setCreating(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      padding: 24,
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none', border: 'none', color: '#555',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem',
              padding: 0, marginBottom: 16,
            }}
          >
            ← Back
          </button>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>
            Create Game
          </h1>
          <p style={{ color: '#666', fontSize: '0.88rem', marginTop: 6 }}>
            Configure your game settings
          </p>
        </div>

        {/* City Selection */}
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>City</label>
          <CityPicker value={cityFilter} onChange={setCityFilter} />
        </div>

        {/* Game Name */}
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>Game Name</label>
          <input
            type="text"
            value={gameName}
            onChange={(e) => setGameName(e.target.value)}
            placeholder="Saturday Night Brooklyn Rush"
            style={inputStyle}
          />
        </div>

        {/* Zone Selection */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>
            Active Zones ({selectedZones.length} selected)
          </label>
          {loadingZones ? (
            <p style={{ color: '#555', fontSize: '0.85rem' }}>Loading zones...</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {zones.map((zone) => {
                const isSelected = selectedZones.includes(zone.id)
                return (
                  <button
                    key={zone.id}
                    onClick={() => toggleZone(zone.id)}
                    style={{
                      background: isSelected
                        ? 'rgba(6,214,160,0.12)'
                        : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isSelected ? 'rgba(6,214,160,0.3)' : '#222'}`,
                      borderRadius: 8,
                      padding: '12px 16px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{
                      color: isSelected ? '#06D6A0' : '#666',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                    }}>
                      {zone.name}
                    </span>
                    <span style={{ color: isSelected ? '#06D6A0' : '#333', fontSize: '0.85rem' }}>
                      {isSelected ? '✓' : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Zone Closure Schedule — optional, toggled by button */}
        {selectedZones.length > 0 && !loadingZones && (
          <div style={{ marginBottom: 24 }}>
            <button
              onClick={() => setShowClosureSchedule((v) => !v)}
              style={{
                background: showClosureSchedule
                  ? 'rgba(247,127,0,0.1)'
                  : 'rgba(255,255,255,0.03)',
                border: `1px solid ${showClosureSchedule ? 'rgba(247,127,0,0.3)' : '#222'}`,
                color: showClosureSchedule ? '#F77F00' : '#666',
                borderRadius: 8,
                padding: '10px 16px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 600,
                fontSize: '0.85rem',
                width: '100%',
                textAlign: 'left',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>⏱ Zone Closure Schedule (optional)</span>
              <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                {showClosureSchedule ? 'hide ▲' : 'set times ▼'}
              </span>
            </button>

            {showClosureSchedule && (
              <div style={{
                border: '1px solid rgba(247,127,0,0.2)',
                borderTop: 'none',
                borderRadius: '0 0 8px 8px',
                padding: '16px',
                background: 'rgba(247,127,0,0.04)',
              }}>
                <p style={{
                  color: '#888',
                  fontSize: '0.82rem',
                  lineHeight: 1.6,
                  marginBottom: 16,
                }}>
                  Set the minute mark when each zone closes. Closed zones appear locked on the map — teams keep points already earned but can't score new ones. Leave blank to never close.
                </p>

                <div style={{ display: 'grid', gap: 10 }}>
                  {zones
                    .filter((z) => selectedZones.includes(z.id))
                    .map((zone) => {
                      const val = zoneCloseMinutes[zone.id] || ''
                      const closeMin = parseInt(val)
                      const isValid = val === '' || (!isNaN(closeMin) && closeMin > 0 && closeMin <= durationMinutes)

                      return (
                        <div
                          key={zone.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            justifyContent: 'space-between',
                          }}
                        >
                          <span style={{
                            color: '#ccc',
                            fontSize: '0.88rem',
                            fontWeight: 600,
                            flex: 1,
                          }}>
                            {zone.name}
                          </span>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              type="number"
                              placeholder="never"
                              value={val}
                              min={1}
                              max={durationMinutes}
                              onChange={(e) =>
                                setZoneCloseMinutes((prev) => ({
                                  ...prev,
                                  [zone.id]: e.target.value,
                                }))
                              }
                              style={{
                                width: 80,
                                background: 'rgba(255,255,255,0.06)',
                                border: `1px solid ${isValid ? '#333' : '#EF476F'}`,
                                borderRadius: 6,
                                padding: '8px 10px',
                                color: val ? '#F77F00' : '#555',
                                fontSize: '0.9rem',
                                fontFamily: 'inherit',
                                outline: 'none',
                                textAlign: 'center',
                              }}
                            />
                            <span style={{ color: '#555', fontSize: '0.78rem' }}>min</span>
                          </div>

                          {/* Preview: show what time that is in a 3hr game */}
                          {val && !isNaN(closeMin) && closeMin > 0 && (
                            <span style={{
                              color: '#F77F00',
                              fontSize: '0.75rem',
                              minWidth: 48,
                              textAlign: 'right',
                              opacity: 0.8,
                            }}>
                              {closeMin >= 60
                                ? `${Math.floor(closeMin / 60)}h${closeMin % 60 > 0 ? `${closeMin % 60}m` : ''}`
                                : `${closeMin}m`}
                            </span>
                          )}
                        </div>
                      )
                    })}
                </div>

                {/* Summary of what's been scheduled */}
                {buildCloseSchedule().length > 0 && (
                  <div style={{
                    marginTop: 14,
                    padding: '10px 14px',
                    background: 'rgba(247,127,0,0.08)',
                    borderRadius: 8,
                    border: '1px solid rgba(247,127,0,0.15)',
                  }}>
                    <p style={{ color: '#F77F00', fontSize: '0.78rem', fontWeight: 700, marginBottom: 6 }}>
                      CLOSURE SCHEDULE
                    </p>
                    {buildCloseSchedule()
                      .sort((a, b) => a.close_at_minutes - b.close_at_minutes)
                      .map((entry) => {
                        const zone = zones.find((z) => z.id === entry.zone_id)
                        return (
                          <p key={entry.zone_id} style={{ color: '#ccc', fontSize: '0.82rem', marginBottom: 4 }}>
                            {zone?.name} closes at {entry.close_at_minutes} min
                          </p>
                        )
                      })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Settings Grid */}
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>Game Settings</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <SettingInput
              label="Max Teams"
              value={maxTeams}
              onChange={setMaxTeams}
              min={2}
              max={10}
            />
            <SettingInput
              label="Team Size"
              value={teamSize}
              onChange={setTeamSize}
              min={1}
              max={6}
            />
            <SettingInput
              label="Duration (min)"
              value={durationMinutes}
              onChange={setDurationMinutes}
              min={30}
              max={480}
              step={15}
            />
            <SettingInput
              label="Zone Claim (pts)"
              value={claimThreshold}
              onChange={setClaimThreshold}
              min={4}
              max={10}
            />
            <SettingInput
              label="Zone Bonus"
              value={zoneBonusPoints}
              onChange={setZoneBonusPoints}
              min={0}
              max={5}
            />
            <SettingInput
              label="Discards"
              value={discardLimit}
              onChange={setDiscardLimit}
              min={0}
              max={5}
            />
            <SettingInput
              label="Hand Size"
              value={handSize}
              onChange={setHandSize}
              min={3}
              max={8}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <p style={{
            color: '#EF476F',
            fontSize: '0.85rem',
            marginBottom: 16,
            padding: '10px 14px',
            background: 'rgba(239,71,111,0.08)',
            borderRadius: 8,
          }}>
            {error}
          </p>
        )}

        {/* Create Button */}
        <button
          onClick={handleCreateGame}
          disabled={creating}
          style={{
            width: '100%',
            background: creating ? '#333' : 'rgba(255,209,102,0.15)',
            border: '1px solid rgba(255,209,102,0.3)',
            color: creating ? '#666' : '#FFD166',
            padding: '16px 24px',
            borderRadius: 12,
            fontSize: '1.05rem',
            fontWeight: 700,
            cursor: creating ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {creating ? 'Creating...' : 'Create Game'}
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// Reusable setting input component
// =============================================================================
function SettingInput({
  label, value, onChange, min, max, step = 1,
}: {
  label: string
  value: number
  onChange: (val: number) => void
  min: number
  max: number
  step?: number
}) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid #1a1a1a',
      borderRadius: 8,
      padding: '10px 14px',
    }}>
      <p style={{
        fontSize: '0.72rem',
        color: '#666',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 6,
      }}>
        {label}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={() => onChange(Math.max(min, value - step))}
          style={stepBtnStyle}
        >
          −
        </button>
        <span style={{
          color: '#fff',
          fontWeight: 700,
          fontSize: '1.1rem',
          minWidth: 36,
          textAlign: 'center',
        }}>
          {value}
        </span>
        <button
          onClick={() => onChange(Math.min(max, value + step))}
          style={stepBtnStyle}
        >
          +
        </button>
      </div>
    </div>
  )
}

function CityPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [cities, setCities] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    async function load() {
      const snapshot = await getDocs(collection(db, 'cities'))
      const list = snapshot.docs
        .map((d) => ({ id: d.id, name: d.data().name }))
        .filter((c) => c.name)
      setCities(list)
    }
    load()
  }, [])

  if (cities.length <= 1) return null

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {cities.map((city) => (
        <button
          key={city.id}
          onClick={() => onChange(city.id)}
          style={{
            background: value === city.id
              ? 'rgba(255,209,102,0.15)'
              : 'rgba(255,255,255,0.03)',
            border: `1px solid ${value === city.id ? 'rgba(255,209,102,0.3)' : '#222'}`,
            color: value === city.id ? '#FFD166' : '#666',
            borderRadius: 8,
            padding: '10px 18px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}
        >
          {city.name}
        </button>
      ))}
    </div>
  )
}

// =============================================================================
// Styles
// =============================================================================
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.78rem',
  color: '#FFD166',
  textTransform: 'uppercase',
  letterSpacing: 1,
  fontWeight: 700,
  marginBottom: 10,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid #333',
  borderRadius: 8,
  padding: '12px 14px',
  color: '#fff',
  fontSize: '0.95rem',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
}

const stepBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid #333',
  color: '#ccc',
  width: 32,
  height: 32,
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: '1rem',
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
}