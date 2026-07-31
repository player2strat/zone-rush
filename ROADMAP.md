# Zone Rush — Roadmap / Deferred Work

A running list of planned and deferred work. Kept in the repo so it travels with
the code and syncs into the claude.ai project (if connected as a knowledge source).

## Zone Builder — zone editing

**Shipped**
- Draw/edit/delete zones; duplicate maps; boundary draw + GeoJSON import; coverage/gap overlay; publish.
- "Fit neighbors" carve — an edited/drawn zone wins the contested area and overlapping neighbors are trimmed to a clean shared border on save.
- **Border snapping** — draw-time and edit-time. Points placed while drawing, and vertices dragged while editing, snap onto nearby zone borders / the map boundary (12px screen radius, `SNAP_PIXELS` in `src/pages/ZoneBuilder.tsx`), with a pink indicator dot.

**Deferred follow-ups** (rough priority)
1. **Snap radius tuning** — adjust `SNAP_PIXELS` (currently 12) if snapping feels too grabby or too loose in real use.
2. **Alt-to-bypass snapping** — hold a modifier key to place a point near-but-not-on a border without snapping.
3. **Fill-gap tool** — make the orange coverage-gap slivers clickable → assign each to a chosen adjacent zone (Turf union). Quick win; reuses the existing gap math. Directly fixes leftover holes.
4. **Merge tool** — select two adjacent zones → combine into one (Turf union). Quick win.
5. **Split tool** — draw a line across a zone → cut into two that share the exact cut line. Merge + split together let you re-draw a shared border with zero vertex dragging.

## Zone Manager

- **City-filter the zone load** — currently loads every zone in the DB (no city filter), which won't scale as more zones/cities are added. Filter the load by selected city; the per-map filter already exists in the UI.
- The "Save selected zones as a new map" panel overlaps with the Zone Builder's scoped "Import map from GeoJSON" flow (the preferred path). Kept for now; consider removing later to avoid two ways to do the same thing.
