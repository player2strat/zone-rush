// =============================================================================
// Zone Rush — useGameRoute Hook
//
// Single source of truth for "where should this user be right now,
// given the state of their game?"
//
// Subscribes to the game document and returns the canonical path the user
// should be on. Used by GameRouteGuard to detect URL/state mismatches and
// redirect once. Eliminates the race between LobbyPage, GamePage, and
// ActiveGameRedirect all trying to navigate independently.
//
// Returns:
//   { loading, gameStatus, expectedPath, isGM }
//
// - loading: true until the first snapshot arrives
// - gameStatus: current game.status, or null if loading/missing
// - expectedPath: the path this user should be on right now, e.g.
//     '/lobby/abc'   when game is in lobby
//     '/gm/abc'      when game is