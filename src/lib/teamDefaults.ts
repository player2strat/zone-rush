// =============================================================================
// Foray — default team names + colors
//
// Single source of truth used by CreateGame (pre-seeding team docs) and
// LobbyPage (creating a team on the fly). team_N's seeded name/color must agree
// in both places, which is why this lives in one module.
// =============================================================================

export const TEAM_NAMES = [
  'The Bodega Cats',
  'Subway Surfers',
  'Pigeon Squad',
  'The Jaywalkers',
  'Borough Bosses',
  'Street Legends',
  'The Wanderers',
  'Zone Runners',
]

export const TEAM_COLORS = [
  { name: 'Red', hex: '#EF476F' },
  { name: 'Blue', hex: '#118AB2' },
  { name: 'Green', hex: '#06D6A0' },
  { name: 'Purple', hex: '#9B5DE5' },
  { name: 'Orange', hex: '#F77F00' },
  { name: 'Yellow', hex: '#FFD166' },
  { name: 'Pink', hex: '#FF6B8A' },
  { name: 'Teal', hex: '#2EC4B6' },
]

/** Default name for the team at 0-based `index`; "Team N" once the pool runs out. */
export function defaultTeamName(index: number): string {
  return TEAM_NAMES[index] || 'Team ' + (index + 1)
}

/** Default color hex for the team at 0-based `index`. */
export function defaultTeamColor(index: number): string {
  return TEAM_COLORS[index]?.hex || '#888'
}
