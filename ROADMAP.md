# Zone Rush — Roadmap / Deferred Work

A running list of planned and deferred work. Kept in the repo so it travels with
the code and syncs into the claude.ai project (if connected as a knowledge source).

## Zone Builder — zone editing

**Shipped**
- Draw/edit/delete zones; duplicate maps; boundary draw + GeoJSON import; coverage/gap overlay; publish.
- "Fit neighbors" carve — an edited/drawn zone wins the contested area and overlapping neighbors are trimmed to a clean shared border on save.
- **Merge tool** — pick a zone to keep, then an adjacent zone; the second is unioned into the first and deleted. Tags/transit/landmarks combined; name editable before confirm.
- **Split tool** — pick a zone, draw a line across it; preview both halves (green keeps the zone's id, yellow becomes a new zone copying its metadata), name them, confirm. Both refuse while games are in progress on the map.
- **Fill-gap tool** — orange coverage-gap slivers are clickable; pick an adjacent zone (only zones that touch the sliver are offered) and confirm → the sliver is unioned into that zone.
- **Border snapping** — draw-time and edit-time. Points placed while drawing, and vertices dragged while editing, snap onto nearby zone borders / the map boundary (12px screen radius, `SNAP_PIXELS` in `src/pages/ZoneBuilder.tsx`), with a pink indicator dot.

**Deferred follow-ups** (rough priority)
1. **Snap radius tuning** — adjust `SNAP_PIXELS` (currently 12) if snapping feels too grabby or too loose in real use.
2. **Alt-to-bypass snapping** — hold a modifier key to place a point near-but-not-on a border without snapping.

## Game data safety

- **Verify the `teams` collection-group index exists** in the Firebase console. `App.tsx` `findActiveGameForUser` runs `collectionGroup('teams')` + `array-contains` on `members`, which needs a collection-group-scoped index on `members`; if it's missing, the query fails silently and players are never auto-returned to their game.

- **Shipped (2026-08-22): per-game zone snapshot.** `CreateGame` copies every selected zone doc into `games/{id}/zones/{zoneId}` in the same batch as the game. `src/lib/gameZones.ts` `loadGameZones()` is the one reader (GamePage, GMDashboard, ResultsPage, SubmitProof, activity log); it falls back to the global `zones` collection for games created before this. Library edits/merges/splits/deletes can no longer alter a game's history.
  - Follow-up: a one-off backfill for games created before the snapshot (copy their `game.zones` ids from the library while those zones still exist).
  - Follow-up: with snapshots in place, the merge/split "blocked while games are in progress" guard is now conservative rather than necessary; could be relaxed.

## Playtest checklist (features shipped but not yet verified in a real game)

- [ ] **Zone opening schedule** — create a game with one zone set to "opens at 15 min"; confirm it starts closed on all maps, rejects submissions, and flips open on schedule (check from both GM screen and a player phone; also try backgrounding all phones past the minute and reopening).
- [ ] **Zone closure schedule** — still fires correctly alongside an opening (set both on different zones in one game).
- [ ] **Teammates on map** — two players on one team; each sees the other's dot (team color, first name) on the Map tab; dot disappears ~5 min after a phone goes dark.
- [ ] **Withdraw pending submission** — submit a photo, cancel via expanded card and via the ↺ chip on the collapsed card; card returns to Submit; GM's pending queue updates live; resubmit works.
- [ ] **Player post-game view** — finished game shows final zone map + team submissions gallery (photos open, videos play, deleted-media placeholder shows).
- [ ] **Past Forays page** — home → Past Forays lists finished games with team name/color, GM badge, date; rows open the right results.
- [ ] **Late join** — enter code for an in-progress game on a fresh account → name → waiting screen → GM approves from dashboard banner → player lands in game on the right team. Also test Deny and Cancel request.
- [ ] **GM/player home split** — player account sees only Join Game; typing /create redirects home; player creating a game via console is rejected by rules.
- [ ] **Leave Lobby** — player leaves an unstarted lobby, home no longer bounces them back; rejoining via code works.
- [ ] **Per-game zone snapshot** — create a game, then edit/split one of its zones in Zone Builder; the live game's map is unchanged.
- [ ] **Zone Builder tools** — fill-gap, merge, split on a scratch map (duplicate a real one first); map delete blocked while a game is live.

## Zone schedules

- **Server-side schedule guarantee** — zone open/close schedules are client-driven (GM + player screens run the check on load, foreground, and once a minute; writes are atomic). If nobody has the app open, a change lands when the first screen wakes. A Cloud Functions scheduled job would make timing exact, but needs the Blaze plan.

## Zone Manager

- **City-filter the zone load** — currently loads every zone in the DB (no city filter), which won't scale as more zones/cities are added. Filter the load by selected city; the per-map filter already exists in the UI.
- The "Save selected zones as a new map" panel overlaps with the Zone Builder's scoped "Import map from GeoJSON" flow (the preferred path). Kept for now; consider removing later to avoid two ways to do the same thing.
