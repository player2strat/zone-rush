// =============================================================================
// Zone Builder (admin/GM only)
// Click-and-drag polygon drawing on a Mapbox map, writing directly into the
// maps/zones Firestore structure. Flow: open/create a map → draw its outer
// boundary → draw zones (name + tags) → save → publish.
//
// Gated by AdminGuard in App.tsx (admin/gm roles only). Firestore rules already
// restrict maps/zones writes to admin/GM, so no rules change is needed.
//
// Built in steps — this is the skeleton (step 1). Map, drawing, validation,
// and coverage aid land in later commits.
// =============================================================================

export default function ZoneBuilder() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#fff",
        fontFamily: "'DM Sans', sans-serif",
        padding: "24px",
      }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 4 }}>
          Zone Builder
        </h1>
        <p style={{ color: "#888", fontSize: "0.9rem" }}>
          Draw zones and map boundaries directly onto the map. (Coming online in
          steps.)
        </p>
      </div>
    </div>
  );
}
