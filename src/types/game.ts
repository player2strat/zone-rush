// =============================================================================
// Zone Rush — Core Types
// Single source of truth for all Firestore document shapes.
// Keep this in sync with the data model — if you add a field in Firestore,
// add it here too.
// =============================================================================

// ─── Zone ────────────────────────────────────────────────────────────────────

export interface Zone {
  id: string
  district_number: number
  name: string
  city: string
  boundary: {
    type: string
    coordinates: number[][][]
  }
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

export interface ZoneLockSchedule {
  zone_id: string
  lock_at_pct: number   // 0–100: % of game duration elapsed before this zone locks
}

export interface GameSettings {
  claim_threshold: number         // Points needed to claim a zone (default: 6)
  zone_bonus_points: number       // Bonus awarded on first claim (default: 3)
  discard_limit: number           // Times a team can discard+draw per game (default: 1)
  team_size: number               // Target players per team (default: 3)
  duration_minutes: number        // Total game length in minutes (default: 180)
  hand_size: number               // Challenge cards per team (default: 6)
  taxi_limit: number              // Taxi/rideshare uses allowed per team (default: 1)
  zone_schedule: ZoneLockSchedule[] // Time-based zone lockdown config
  score_reveal_times: number[]    // % of game time to auto-broadcast scores (e.g. [50, 75])
  zone_close_schedule?: { zone_id: string; close_at_minutes: number }[]
  closed_zones?: string[]
}



// ─── Game ─────────────────────────────────────────────────────────────────────

export interface Game {
  id: string
  name: string
  city: string
  status: 'lobby' | 'active' | 'paused' | 'ended'
  created_by: string              // UID of the GM who created this game
  join_code: string               // 6-character code players use to join
  zones: string[]                 // Active zone IDs for this game
  started_at: any                 // Firestore Timestamp
  ends_at: any                    // Firestore Timestamp
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
  taxi_used: boolean              // Whether the team has used their one taxi ride
  hand: string[]                  // Challenge IDs currently in hand
  discard_used: number            // How many discards have been used (max: settings.discard_limit)
  color: string                   // Hex color for map display (e.g. "#EF476F")
}

// ─── ZoneScore (sub-collection of Game) ──────────────────────────────────────

export interface ZoneScore {
  id: string                      // Composite key: "teamId__zoneId"
  team_id: string
  zone_id: string
  points: number                  // Total points this team has earned in this zone
  status: 'none' | 'claimed' | 'locked_out'
  // 'none'        = team has points here but hasn't claimed
  // 'claimed'     = team holds this zone (reached claim_threshold)
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
// Written to Firestore when GM triggers a score reveal.
// All player clients listen for this and show the overlay.

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