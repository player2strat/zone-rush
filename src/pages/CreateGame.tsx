// =============================================================================
// Zone Rush — Create Game Page (v2)
// 3-step flow: Basics → Zones → Settings & Create
// Zones are NOT pre-selected — GM picks them.
// Zone closure uses a dropdown, not a free-form number input.
// All settings stored in Firestore — never hardcoded.
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

function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

// Closure time presets — filtered to only show options that fit within game duration
const CLOSURE_PRESETS = [
  { label: 'Never', value: '' },
  { label: '30 min', value: '30' },
  { label: '45 min', value: '45' },
  { label: '60 min', value: '60' },
  { label: '75 min', value: '75' },
  { label: '90 min', value: '90' },
  { label: '120 min', value: '120' },
  { label: '150 min', value: '150' },
]

export default function CreateGame() {
  const navigate = useNavigate()
  const user = auth.currentUser

  // Step tracker: 1 = Basics, 2 = Zones, 3 = Settings & Create
  const [step, setStep] = useState(1)

  // Zone data
  const [zones, setZones] = useState<ZoneDoc[]>([])
  const [selectedZones, setSelectedZones] = useState<string[]>([]) // nothing pre-selected
  const [loadingZones, setLoadingZones] = useState(true)
  const [cityFilter, setCityFilter] = useState('nyc')

  // Closure schedule: zone_id → close_at_minutes string ('' = never)
  const [zoneCloseMinutes, setZoneCloseMinutes] = useState<Record<string, string>>({})

  // Step 1: Basics
  const [gameName, setGameName] = useState('')
  const [maxTeams, setMaxTeams] = useState(3)
  const [teamSize, setTeamSize] = useState(3)
  const [durationMinutes, setDurationMinutes] = useState(180)

  // Step 3: Advanced settings (collapsed by default)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [claimThreshold, setClaimThreshold] = useState(6)
  const [zoneBonusPoints, setZoneBonusPoints] = useState(3)
  const [discardLimit, setDiscardLimit] = useState(1)
  const [handSize, setHandSize] = useState(5)
  const [lockThreshold, setLockThreshold] = useState(10)

  // Hand composition rules — configurable per game, stored in game.settings
  // These control how challenge cards are distributed when the game starts.
  // dealChallenges.ts uses these values; falls back to these defaults if missing.
  const [handMinEasy, setHandMinEasy] = useState(1) // minimum Easy cards per hand
  const [handMinHard, setHandMinHard] = useState(1) // minimum Hard cards per hand
  const [handMaxHard, setHandMaxHard] = useState(2) // maximum Hard cards per hand

  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  // Load zones on mount
  useEffect(() => {
    async function loadZones() {
      setLoadingZones(true)
      try {
        const q = query(collection(db, 'zones'), where('city', '==', cityFilter))
        const snapshot = await getDocs(q)
        const zoneDocs: ZoneDoc[] = []
        snapshot.forEach((d) => {
          const data = d.data()
          zoneDocs.push({
            id: d.id,
            name: data.name,
            district_number: data.district_number,
            city: data.city,
          })
        })
        zoneDocs.sort((a, b) => a.district_number - b.district_number)
        setZones(zoneDocs)
        setSelectedZones([]) // always start with nothing selected
      } catch (err: any) {
        setError('Failed to load zones: ' + err.message)
      }
      setLoadingZones(false)
    }
    loadZones()
  }, [cityFilter])

  const toggleZone = (zoneId: string) => {
    setSelectedZones((prev) =>
      prev.includes(zoneId) ? prev.filter((id) => id !== zoneId) : [...prev, zoneId]
    )
  }

  const selectAll = () => setSelectedZones(zones.map((z) => z.id))
  const clearAll = () => setSelectedZones([])

  // Closure presets filtered to fit within game duration
  const availablePresets = CLOSURE_PRESETS.filter(
    (p) => p.value === '' || parseInt(p.value) < durationMinutes
  )

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

  // Step validation
  const step1Valid = gameName.trim().length > 0
  const step2Valid = selectedZones.length > 0

  const handleCreateGame = async () => {
    if (!user) return
    setCreating(true)
    setError('')
    try {
      const joinCode = generateJoinCode()
      const gameId = 'game_' + Date.now()

      await setDoc(doc(db, 'games', gameId), {
        id: gameId,
        name: gameName.trim(),
        city: cityFilter,
        status: 'lobby',
        created_by: user.uid,
        join_code: joinCode,
        max_teams: maxTeams,
        zones: selectedZones,
        closed_zones: [],
        started_at: null,
        ends_at: null,
        created_at: new Date(),
        settings: {
          team_size: teamSize,
          duration_minutes: durationMinutes,
          claim_threshold: claimThreshold,
          lock_threshold: lockThreshold,
          zone_bonus_points: zoneBonusPoints,
          discard_limit: discardLimit,
          hand_size: handSize,
          // Hand composition rules — read by dealChallenges.ts when game starts
          hand_min_easy: handMinEasy,
          hand_min_hard: handMinHard,
          hand_max_hard: handMaxHard,
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
          zone_close_schedule: buildCloseSchedule(),
        },
      })

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
      padding: '24px 24px 48px',
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>

        {/* Back button */}
        <button
          onClick={() => step > 1 ? setStep(step - 1) : navigate('/')}
          style={{
            background: 'none', border: 'none', color: '#555',
            cursor: 'pointer', fontFamily: 'inherit',
            fontSize: '0.85rem', padding: 0, marginBottom: 24,
          }}
        >
          ← {step > 1 ? 'Back' : 'Home'}
        </button>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
          {[
            { n: 1, label: 'Basics' },
            { n: 2, label: 'Zones' },
            { n: 3, label: 'Settings' },
          ].map(({ n, label }, i) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: step === n
                  ? 'rgba(255,209,102,0.2)'
                  : step > n
                  ? 'rgba(6,214,160,0.15)'
                  : 'rgba(255,255,255,0.04)',
                border: `1px solid ${step === n ? 'rgba(255,209,102,0.4)' : step > n ? 'rgba(6,214,160,0.3)' : '#222'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.78rem', fontWeight: 700,
                color: step === n ? '#FFD166' : step > n ? '#06D6A0' : '#444',
              }}>
                {step > n ? '✓' : n}
              </div>
              <span style={{
                fontSize: '0.8rem', fontWeight: 600,
                color: step === n ? '#FFD166' : step > n ? '#06D6A0' : '#444',
              }}>
                {label}
              </span>
              {i < 2 && (
                <div style={{
                  width: 24, height: 1,
                  background: step > n ? 'rgba(6,214,160,0.3)' : '#222',
                }} />
              )}
            </div>
          ))}
        </div>

        {/* ================================================================
            STEP 1: Basics
        ================================================================ */}
        {step === 1 && (
          <div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0 0 4px' }}>
              Game Basics
            </h1>
            <p style={{ color: '#555', fontSize: '0.85rem', marginBottom: 28 }}>
              Name your game and set the format
            </p>

            {/* City (hidden if only 1 city) */}
            <CityPicker value={cityFilter} onChange={setCityFilter} />

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Game Name</label>
              <input
                type="text"
                value={gameName}
                onChange={(e) => setGameName(e.target.value)}
                placeholder="Saturday Night Brooklyn Rush"
                style={inputStyle}
                autoFocus
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <SettingInput label="Teams" value={maxTeams} onChange={setMaxTeams} min={1} max={10} />
              <SettingInput label="Players / Team" value={teamSize} onChange={setTeamSize} min={1} max={8} />
            </div>

            <div style={{ marginBottom: 28 }}>
              <label style={labelStyle}>Duration</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[60, 90, 120, 150, 180, 240].map((mins) => (
                  <button
                    key={mins}
                    onClick={() => setDurationMinutes(mins)}
                    style={{
                      background: durationMinutes === mins
                        ? 'rgba(255,209,102,0.15)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${durationMinutes === mins ? 'rgba(255,209,102,0.35)' : '#222'}`,
                      color: durationMinutes === mins ? '#FFD166' : '#666',
                      borderRadius: 8,
                      padding: '10px 16px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontWeight: 600,
                      fontSize: '0.88rem',
                    }}
                  >
                    {mins >= 60 ? `${mins / 60}h` : `${mins}m`}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => { setError(''); setStep(2) }}
              disabled={!step1Valid}
              style={primaryBtnStyle(!step1Valid)}
            >
              Next: Select Zones →
            </button>
          </div>
        )}

        {/* ================================================================
            STEP 2: Zone Selection
        ================================================================ */}
        {step === 2 && (
          <div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0 0 4px' }}>
              Select Zones
            </h1>
            <p style={{ color: '#555', fontSize: '0.85rem', marginBottom: 20 }}>
              Tap to include a zone in this game
            </p>

            {loadingZones ? (
              <p style={{ color: '#555', fontSize: '0.85rem' }}>Loading zones...</p>
            ) : (
              <>
                {/* Select all / clear */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  <button onClick={selectAll} style={ghostBtnStyle}>
                    Select all ({zones.length})
                  </button>
                  {selectedZones.length > 0 && (
                    <button onClick={clearAll} style={ghostBtnStyle}>
                      Clear
                    </button>
                  )}
                  {selectedZones.length > 0 && (
                    <span style={{ color: '#06D6A0', fontSize: '0.82rem', fontWeight: 600, alignSelf: 'center' }}>
                      {selectedZones.length} selected
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gap: 8, marginBottom: 28 }}>
                  {zones.map((zone) => {
                    const isSelected = selectedZones.includes(zone.id)
                    return (
                      <button
                        key={zone.id}
                        onClick={() => toggleZone(zone.id)}
                        style={{
                          background: isSelected
                            ? 'rgba(6,214,160,0.1)' : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${isSelected ? 'rgba(6,214,160,0.3)' : '#1e1e1e'}`,
                          borderRadius: 8,
                          padding: '12px 16px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          transition: 'all 0.12s',
                        }}
                      >
                        <span style={{
                          color: isSelected ? '#06D6A0' : '#888',
                          fontWeight: 600, fontSize: '0.9rem',
                        }}>
                          {zone.name}
                        </span>
                        <div style={{
                          width: 20, height: 20, borderRadius: 4,
                          border: `1.5px solid ${isSelected ? '#06D6A0' : '#333'}`,
                          background: isSelected ? 'rgba(6,214,160,0.15)' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.7rem', color: '#06D6A0', fontWeight: 700,
                          flexShrink: 0,
                        }}>
                          {isSelected ? '✓' : ''}
                        </div>
                      </button>
                    )
                  })}
                </div>

                {error && <p style={errorStyle}>{error}</p>}

                <button
                  onClick={() => {
                    if (!step2Valid) { setError('Select at least one zone'); return }
                    setError('')
                    setStep(3)
                  }}
                  style={primaryBtnStyle(false)}
                >
                  Next: Settings →
                </button>
              </>
            )}
          </div>
        )}

        {/* ================================================================
            STEP 3: Zone Closure + Advanced Settings + Create
        ================================================================ */}
        {step === 3 && (
          <div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0 0 4px' }}>
              Final Settings
            </h1>
            <p style={{ color: '#555', fontSize: '0.85rem', marginBottom: 24 }}>
              Set zone closure times and review before creating
            </p>

            {/* Zone closure schedule */}
            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Zone Closure Schedule</label>
              <p style={{ color: '#666', fontSize: '0.82rem', lineHeight: 1.6, marginBottom: 14 }}>
                Zones close at a set time — teams keep points earned but can't score new ones after closing. Shrinks the map as the game winds down.
              </p>

              <div style={{
                border: '1px solid #1e1e1e',
                borderRadius: 10,
                overflow: 'hidden',
              }}>
                {zones
                  .filter((z) => selectedZones.includes(z.id))
                  .map((zone, i, arr) => {
                    const val = zoneCloseMinutes[zone.id] || ''
                    return (
                      <div
                        key={zone.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '12px 16px',
                          borderBottom: i < arr.length - 1 ? '1px solid #111' : 'none',
                          background: val ? 'rgba(247,127,0,0.04)' : 'transparent',
                        }}
                      >
                        <span style={{ color: '#ccc', fontSize: '0.88rem', fontWeight: 600 }}>
                          {zone.name}
                        </span>
                        <select
                          value={val}
                          onChange={(e) =>
                            setZoneCloseMinutes((prev) => ({
                              ...prev,
                              [zone.id]: e.target.value,
                            }))
                          }
                          style={{
                            background: '#111',
                            border: `1px solid ${val ? 'rgba(247,127,0,0.35)' : '#333'}`,
                            borderRadius: 6,
                            color: val ? '#F77F00' : '#555',
                            padding: '7px 10px',
                            fontSize: '0.85rem',
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                            outline: 'none',
                            minWidth: 110,
                          }}
                        >
                          {availablePresets.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
              </div>

              {/* Summary if any closures set */}
              {buildCloseSchedule().length > 0 && (
                <div style={{
                  marginTop: 12,
                  padding: '10px 14px',
                  background: 'rgba(247,127,0,0.06)',
                  borderRadius: 8,
                  border: '1px solid rgba(247,127,0,0.15)',
                }}>
                  {buildCloseSchedule()
                    .sort((a, b) => a.close_at_minutes - b.close_at_minutes)
                    .map((entry) => {
                      const zone = zones.find((z) => z.id === entry.zone_id)
                      return (
                        <p key={entry.zone_id} style={{ color: '#F77F00', fontSize: '0.82rem', marginBottom: 3 }}>
                          ⏱ {zone?.name} closes at {entry.close_at_minutes} min
                        </p>
                      )
                    })}
                </div>
              )}
            </div>

            {/* Advanced settings (collapsed) */}
            <div style={{ marginBottom: 28 }}>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                style={{
                  width: '100%',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid #1e1e1e',
                  borderRadius: 8,
                  padding: '11px 16px',
                  color: '#555',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  textAlign: 'left',
                }}
              >
                <span>⚙️ Advanced Settings</span>
                <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {showAdvanced ? 'hide ▲' : 'show ▼'}
                </span>
              </button>

              {showAdvanced && (
                <div style={{
                  border: '1px solid #1e1e1e',
                  borderTop: 'none',
                  borderRadius: '0 0 8px 8px',
                  padding: 16,
                  background: 'rgba(255,255,255,0.01)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <SettingInput
                      label="Zone Claim (pts)"
                      value={claimThreshold}
                      onChange={setClaimThreshold}
                      min={4} max={10}
                    />
                    <SettingInput
                      label="Zone Bonus"
                      value={zoneBonusPoints}
                      onChange={setZoneBonusPoints}
                      min={0} max={5}
                    />
                    <SettingInput
                      label="Zone Lock (pts)"
                      value={lockThreshold}
                      onChange={setLockThreshold}
                      min={claimThreshold} max={20}
                    />
                    <SettingInput
                      label="Discards"
                      value={discardLimit}
                      onChange={setDiscardLimit}
                      min={0} max={5}
                    />
                    <SettingInput
                      label="Hand Size"
                      value={handSize}
                      onChange={setHandSize}
                      min={3} max={8}
                    />
                  </div>

                  {/* Hand composition divider */}
                  <p style={{
                    fontSize: '0.7rem', color: '#444',
                    textTransform: 'uppercase', letterSpacing: 1,
                    fontWeight: 700, marginBottom: 10,
                    borderTop: '1px solid #1a1a1a', paddingTop: 14,
                  }}>
                    Hand Composition
                  </p>
                  <p style={{ color: '#555', fontSize: '0.78rem', lineHeight: 1.5, marginBottom: 12 }}>
                    Controls the mix of Easy / Hard cards dealt to each team at game start.
                  </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                    <SettingInput
                      label="Min Easy"
                      value={handMinEasy}
                      onChange={setHandMinEasy}
                      min={0} max={handSize}
                      compact
                    />
                    <SettingInput
                      label="Min Hard"
                      value={handMinHard}
                      onChange={setHandMinHard}
                      min={0} max={handSize}
                      compact
                    />
                    <SettingInput
                      label="Max Hard"
                      value={handMaxHard}
                      onChange={setHandMaxHard}
                      min={0} max={handSize}
                      compact
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Game summary before creating */}
            <div style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid #1e1e1e',
              borderRadius: 10,
              padding: 16,
              marginBottom: 24,
            }}>
              <p style={{ color: '#FFD166', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                Summary
              </p>
              <div style={{ display: 'grid', gap: 6 }}>
                {[
                  { label: 'Name', value: gameName },
                  { label: 'Zones', value: `${selectedZones.length} selected` },
                  { label: 'Teams', value: `${maxTeams} teams × ${teamSize} players` },
                  { label: 'Duration', value: `${durationMinutes} min` },
                  { label: 'Claim / Lock', value: `${claimThreshold}pts / ${lockThreshold}pts` },
                  buildCloseSchedule().length > 0
                    ? { label: 'Zone closures', value: `${buildCloseSchedule().length} scheduled` }
                    : null,
                ]
                  .filter(Boolean)
                  .map((row) => (
                    <div key={row!.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#555', fontSize: '0.85rem' }}>{row!.label}</span>
                      <span style={{ color: '#ccc', fontSize: '0.85rem', fontWeight: 600 }}>{row!.value}</span>
                    </div>
                  ))}
              </div>
            </div>

            {error && <p style={errorStyle}>{error}</p>}

            <button
              onClick={handleCreateGame}
              disabled={creating}
              style={primaryBtnStyle(creating)}
            >
              {creating ? 'Creating...' : '🎯 Create Game'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Sub-components
// =============================================================================

function SettingInput({
  label, value, onChange, min, max, step = 1, compact = false,
}: {
  label: string
  value: number
  onChange: (val: number) => void
  min: number
  max: number
  step?: number
  compact?: boolean
}) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid #1a1a1a',
      borderRadius: 8,
      padding: compact ? '8px 10px' : '10px 14px',
    }}>
      <p style={{
        fontSize: compact ? '0.65rem' : '0.7rem', color: '#666',
        textTransform: 'uppercase', letterSpacing: 0.5,
        marginBottom: 8, fontWeight: 700,
      }}>
        {label}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 6 : 10 }}>
        <button onClick={() => onChange(Math.max(min, value - step))} style={{
          ...stepBtnStyle,
          width: compact ? 22 : 32,
          height: compact ? 22 : 32,
          fontSize: compact ? '0.8rem' : '1rem',
        }}>−</button>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: compact ? '1rem' : '1.1rem', minWidth: compact ? 20 : 36, textAlign: 'center' }}>
          {value}
        </span>
        <button onClick={() => onChange(Math.min(max, value + step))} style={{
          ...stepBtnStyle,
          width: compact ? 22 : 32,
          height: compact ? 22 : 32,
          fontSize: compact ? '0.8rem' : '1rem',
        }}>+</button>
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
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>City</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {cities.map((city) => (
          <button
            key={city.id}
            onClick={() => onChange(city.id)}
            style={{
              background: value === city.id ? 'rgba(255,209,102,0.15)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${value === city.id ? 'rgba(255,209,102,0.3)' : '#222'}`,
              color: value === city.id ? '#FFD166' : '#666',
              borderRadius: 8, padding: '10px 18px',
              cursor: 'pointer', fontFamily: 'inherit',
              fontWeight: 600, fontSize: '0.9rem',
            }}
          >
            {city.name}
          </button>
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// Styles
// =============================================================================

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
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
  width: 32, height: 32,
  borderRadius: 6, cursor: 'pointer',
  fontSize: '1rem', fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'inherit',
}

const errorStyle: React.CSSProperties = {
  color: '#EF476F',
  fontSize: '0.85rem',
  marginBottom: 16,
  padding: '10px 14px',
  background: 'rgba(239,71,111,0.08)',
  borderRadius: 8,
}

const ghostBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid #222',
  color: '#666',
  borderRadius: 7,
  padding: '7px 14px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontWeight: 600,
  fontSize: '0.82rem',
}

const primaryBtnStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  background: disabled ? '#1a1a1a' : 'rgba(255,209,102,0.12)',
  border: `1px solid ${disabled ? '#222' : 'rgba(255,209,102,0.3)'}`,
  color: disabled ? '#444' : '#FFD166',
  padding: '16px 24px',
  borderRadius: 12,
  fontSize: '1rem',
  fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'inherit',
})