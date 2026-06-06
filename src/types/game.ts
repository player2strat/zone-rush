// =============================================================================
// Zone Rush — Core Types
// Single source of truth for all Firestore document shapes.
// Keep this in sync with the data model — if you add a field in Firestore,
// add it here too.
//
// v2 — Reconciled with CreateGame v4, LobbyPage, SeedMaps, and scoring.ts.
//       Added: hand composition fields, side quest bonuses, strategy period,
//       tier2_bonus, map_set_id, borough on zones, dealt_challenges on teams.
// =============================================================================

// ─── Zone ────────────────────────────────────────────────────────────────────

export interface Zone {
  id: string
  name: string
  city: string
  borough?: string                // "Brooklyn" | "Manhattan" — added in v10
  district_number?: number        // Brooklyn zones (Council Districts). Optional for Manhattan.
  nta_code?: string               // Manhattan zones (NTA code, e.g. "MN27"). Optional for Brooklyn.
  full_name?: string              // Full NTA name for Manhattan zones
  boundary: string                // GeoJSON stored as JSON string — parse with JSON.parse()
  center_lat: number
  center_lng: number
  culture_tags: string[]
  transit_lines: string[]
  landmarks: string[]
  difficulty_rating: number
}

// ─── Challenge ───────────────────────────────────────────────────────────────

export interface Challenge {
  id: string
  title: string
  description: string
  difficulty: 'easy' | 'medium' | 'hard'
  points: number                          // Easy=1, Medium=3, Hard=5
  time_estimate: 'short' | 'medium' | 'long'
  player_profile: 'adventurer' | 'academic' | 'gamer' | 'ride_along'
  verification_type: 'photo' | 'video' | 'audio'
  tier2: { description: string; bonus_points: number } | null
  phone_free_eligible: boolean
  city_tags: string[]
  zone_tags: string[]
  is_active: boolean
  created_by: string
  source: 'official' | 'community' | 'partner'
}

// ─── Game Settings ────────────────────────────────────────────────────────────
// ALL numeric thresholds live here — never hardcoded in logic files.

export interface GameSettings {
  // Core thresholds
  claim_threshold: number         // Points needed to claim a zone (default: 6)
  lock_threshold: number          // Points needed to lock a zone (default: 10)
  zone_bonus_points: number       // Bonus awarded on first claim (default: 3)
  discard_limit: number           // Times a team can discard+draw per game (default: 1)
  team_size: number               // Target players per team (default: 3)
  duration_minutes: number        // Total game length in minutes (default: 180)
  hand_size: number               // Challenge cards per team (default: 5)

  // Hand composition rules — read by dealChallenges via LobbyPage
  hand_min_easy?: number          // Minimum Easy cards per hand (default: 1)
  hand_min_hard?: number          // Minimum Hard cards per hand (default: 1)
  hand_max_hard?: number          // Maximum Hard cards per hand (default: 2)

  // Strategy period
  strategy_period_minutes?: number // Minutes before gameplay starts (default: 5)

  // Point values per difficulty
  points_easy?: number            // Points for easy challenges (default: 1)
  points_medium?: number          // Points for medium challenges (default: 3)
  points_hard?: number            // Points for hard challenges (default: 5)

  // Bonus points
  tier2_bonus?: number            // Extra points for completing tier 2 (default: 1)
  phone_free_bonus?: number       // Bonus for no phones (default: 1)
  phone_free_no_talk_bonus?: number // Bonus for no phones + no talking (default: 2)

  // Side quest bonuses (end-of-game)
  most_zones_bonus?: number       // Points for team with most zones claimed (default: 1)
  fastest_return_bonus?: number   // Points for fastest return to start (default: 1)
  hydration_bonus?: number        // Points for hydration clue (default: 1)
  transport_mode_bonus?: number   // Points for most transport modes used (default: 1)

  // Zone closure schedule
  zone_close_schedule?: { zone_id: string; close_at_minutes: number }[]

  // Legacy fields (kept for compatibility, may be removed later)
  taxi_limit?: number             // Taxi/rideshare uses allowed per team
  zone_schedule?: { zone_id: string; lock_at_pct: number }[]
  score_reveal_times?: number[]   // % of game time to auto-broadcast scores
  closed_zones?: string[]
}

// ─── Game ─────────────────────────────────────────────────────────────────────

export interface Game {
  id: string
  name: string
  city: string
  status: 'lobby' | 'strategy' | 'active' | 'paused' | 'ended'
  created_by: string              // UID of the GM who created this game
  join_code: string               // 6-character code players use to join
  max_teams: number               // Maximum number of teams allowed
  zones: string[]                 // Active zone IDs for this game
  closed_zones?: string[]         // Zone IDs that have been closed during gameplay
  map_set_id?: string | null      // Which map_set was used (null for custom)
  started_at: any                 // Firestore Timestamp
  ends_at: any                    // Firestore Timestamp
  created_at?: any                // Firestore Timestamp
  settings: GameSettings
}

// ─── Team (sub-collection of Game) ───────────────────────────────────────────

export interface Team {
  id: string
  name: string
  members: string[]               // Array of Firebase Auth UIDs
  member_names: string[]          // Display names (parallel array to members)
  total_points: number            // Sum of all approved points across all zones
  zones_claimed: number           // Count of zones this team currently holds
  zones_locked?: number           // Count of zones this team has locked
  taxi_used: boolean              // Whether the team has used their one taxi ride
  hand: string[]                  // Challenge IDs currently in hand
  dealt_challenges?: string[]     // Immutable record of initial hand (set on game start)
  discard_used: number            // How many discards have been used (max: settings.discard_limit)
  discarded_challenges?: string[] // Challenge IDs this team has discarded (never recycled back)
  color: string                   // Hex color for map display (e.g. "#EF476F")
}

// ─── ZoneScore (sub-collection of Game) ──────────────────────────────────────

export interface ZoneScore {
  id: string                      // Composite key: "teamId__zoneId"
  team_id: string
  zone_id: string
  points: number                  // Total points this team has earned in this zone
  status: 'none' | 'claimed' | 'locked' | 'locked_out'
  // 'none'        = team has points here but hasn't claimed
  // 'claimed'     = team holds this zone (reached claim_threshold)
  // 'locked'      = team has locked this zone (reached lock_threshold)
  // 'locked_out'  = zone was time-locked; this team's record is frozen
  challenges_completed: string[]  // Challenge IDs approved in this zone
}

// ─── Submission ───────────────────────────────────────────────────────────────

export interface Submission {
  id: string
  game_id: string
  team_id: string
  challenge_id: string
  zone_id: string
  submitted_by: string            // Firebase Auth UID of the player who uploaded
  media_url: string               // Firebase Storage path
  media_type: 'photo' | 'video' | 'audio'
  gps_lat: number | null
  gps_lng: number | null
  in_zone: boolean                // Was GPS inside the declared zone at submission time?
  status: 'pending' | 'approved' | 'rejected'
  gm_notes: string
  reviewed_by: string | null
  reviewed_at: any                // Firestore Timestamp
  attempted_tier2: boolean
  tier2_approved: boolean
  phone_free_claimed: boolean
  phone_free_approved: boolean    // GM confirms phone-free bonus
  submitted_at: any               // Firestore Timestamp
  points_awarded: number          // Set by scoring logic on approval (0 if pending/rejected)
}

// ─── Message ──────────────────────────────────────────────────────────────────

export interface Message {
  id: string
  game_id: string
  channel_type: 'team_to_gm' | 'gm_to_team' | 'gm_broadcast'
  from_uid: string
  from_name: string
  team_id: string | null          // Which team this is to/from. null = broadcast to all
  text: string
  sent_at: any                    // Firestore Timestamp
  read_by: string[]               // UIDs who have seen this message
}

// ─── Score Reveal Event ───────────────────────────────────────────────────────

export interface ScoreReveal {
  id: string
  game_id: string
  triggered_at: any               // Firestore Timestamp
  triggered_by: string            // GM UID
  scores: ScoreRevealEntry[]      // Snapshot of standings at reveal time
  expires_at: any                 // Firestore Timestamp — clients hide overlay after this
}

export interface ScoreRevealEntry {
  team_id: string
  team_name: string
  team_color: string
  total_points: number
  zones_claimed: number
}