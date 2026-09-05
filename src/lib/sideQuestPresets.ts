// =============================================================================
// Foray — recurring side quest presets
//
// Presets carry a FIXED id (e.g. "sq_potholes"), so every game that adds one
// writes submissions under the same quest_id. That's what makes the all-time
// view possible: /admin/side-quests aggregates across games by quest_id.
// One-off quests created in Create Game get unique ids and stay per-game.
// =============================================================================

import type { SideQuest } from '../types/game'

export const SIDE_QUEST_PRESETS: SideQuest[] = [
  {
    id: 'sq_potholes',
    title: 'Pothole Reporting',
    description: 'Take a picture of every pothole you see',
    bonus_points: 8,
  },
]
