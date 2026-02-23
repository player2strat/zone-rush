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
        const q = query(collection(db, 'zones'), where('city', '==', 'nyc'))
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
        // Sort by district number
        zoneDocs.sort((a, b) => a.district_number - b.district_number)
        setZones(zoneDocs)
        // Select all by default
        setSelectedZones(zoneDocs.map((z) => z.id))
      } catch (err: any) {
        setError('Failed to load zones: ' + err.message)
      }
      setLoadingZones(false)
    }
    loadZones()
  }, [])

  const toggleZone = (zoneId: string) => {
    setSelectedZones((prev) =>
      prev.includes(zoneId)
        ? prev.filter((id) => id !== zoneId)
        : [...prev, zoneId]
    )
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

      await setDoc(doc(db, 'games', gameId), {
        id: gameId,
        name: gameName.trim(),
        city: 'nyc',
        status: 'lobby',
        created_by: user.uid,
        join_code: joinCode,
        max_teams: maxTeams,
        zones: selectedZones,
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
        <div style={{ marginBottom: 24 }}>
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
                    <span style={{
                      color: isSelected ? '#06D6A0' : '#333',
                      fontSize: '0.85rem',
                    }}>
                      {isSelected ? '✓' : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

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
              min={2}
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