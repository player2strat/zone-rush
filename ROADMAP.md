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

- **Snapshot zone names into the game doc** at create time (e.g. `zone_names: {id: name}`) so results/history keep proper names even if the map is later deleted. (Map delete is already blocked while games are in progress and warns about finished games.)

## Zone Manager

- **City-filter the zone load** — currently loads every zone in the DB (no city filter), which won't scale as more zones/cities are added. Filter the load by selected city; the per-map filter already exists in the UI.
- The "Save selected zones as a new map" panel overlaps with the Zone Builder's scoped "Import map from GeoJSON" flow (the preferred path). Kept for now; consider removing later to avoid two ways to do the same thing.
