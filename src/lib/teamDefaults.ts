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
  { name: 'Red', hex: '#FF4443' },
  { name: 'Blue', hex: '#1EB2F2' },
  { name: 'Green', hex: '#28B770' },
  { name: 'Purple', hex: '#E67DD1' },
  { name: 'Orange', hex: '#F77F00' },
  { name: 'Yellow', hex: '#FFD626' },
  { name: 'Pink', hex: '#FF6B8A' },
  { name: 'Teal', hex: '#67DAF5' },
]

/** Default name for the team at 0-based `index`; "Team N" once the pool runs out. */
export function defaultTeamName(index: number): string {
  return TEAM_NAMES[index] || 'Team ' + (index + 1)
}

/** Default color hex for the team at 0-based `index`. */
export function defaultTeamColor(index: number): string {
  return TEAM_COLORS[index]?.hex || '#55544E'
}
