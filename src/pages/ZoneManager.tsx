import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, doc, setDoc, deleteDoc, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";

interface MapOption {
  id: string;
  name: string;
}

interface ZoneDraft {
  id: string;
  district_number: number;
  name: string;
  city: string;
  map_id?: string;              // the one map this zone belongs to (preserved on save)
  boundary: any;
  center_lat: number;
  center_lng: number;
  culture_tags: string;
  transit_lines: string;
  landmarks: string;
  difficulty_rating: number;
  isNew?: boolean;
}

// Slug for a generated map doc id, e.g. "Manhattan Alpha" -> "manhattan_alpha".
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "map"
  );
}

// Read a tag-list field from GeoJSON feature properties. Accepts an array or a
// comma/semicolon-separated string; returns the comma-string form this editor
// uses. Tries several key spellings.
function readTagList(props: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = props?.[k];
    if (Array.isArray(v)) {
      return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
    }
    if (typeof v === "string" && v.trim()) {
      return v
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ");
    }
  }
  return "";
}

// Read a numeric difficulty_rating (1–5) from properties; default 3. Zone
// difficulty is numeric, so a non-numeric value (e.g. "hard") falls back to 3.
function readDifficulty(props: Record<string, unknown>): number {
  const v = props?.difficulty_rating ?? props?.difficulty;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3;
}

export default function ZoneManager() {
  const navigate = useNavigate();
  const [zones, setZones] = useState<ZoneDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [expandedZone, setExpandedZone] = useState<string | null>(null);
  const [cityId, setCityId] = useState("nyc");
  const [cityName, setCityName] = useState("New York City");

  // Maps for the current city — used to assign newly-imported zones to a map.
  const [maps, setMaps] = useState<MapOption[]>([]);
  const [assignMapId, setAssignMapId] = useState(""); // map applied to zones that don't have one yet
  const [filterMapId, setFilterMapId] = useState(""); // "" = all maps; else show one map's zones

  // "Save as map" — bundle selected zones into a new maps doc (the collection
  // CreateGame's picker reads; membership lives on zone.map_id). map_sets is
  // legacy and read by nothing, so we write a real map instead.
  const [selectedForMap, setSelectedForMap] = useState<Set<string>>(new Set());
  const [mapName, setMapName] = useState("");
  const [mapBorough, setMapBorough] = useState("");
  const [mapDesc, setMapDesc] = useState("");
  const [savingMap, setSavingMap] = useState(false);

  // Load existing zones from Firestore
  useEffect(() => {
    async function loadZones() {
      const snapshot = await getDocs(collection(db, "zones"));
      const loaded = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          ...data,
          boundary:
            typeof data.boundary === "string"
              ? JSON.parse(data.boundary)
              : data.boundary,
          // Convert arrays to comma-separated strings for easy editing
          culture_tags: (data.culture_tags || []).join(", "),
          transit_lines: (data.transit_lines || []).join(", "),
          landmarks: (data.landmarks || []).join(", "),
        } as ZoneDraft;
      });
      loaded.sort((a, b) => a.district_number - b.district_number);
      setZones(loaded);
      setLoading(false);
    }
    loadZones();
  }, []);

  // Load the maps available for the current city (for the assign-to-map picker)
  useEffect(() => {
    async function loadMaps() {
      try {
        const snap = await getDocs(
          query(collection(db, "maps"), where("city", "==", cityId))
        );
        const list = snap.docs.map((d) => ({
          id: d.id,
          name: (d.data().name as string) || d.id,
        }));
        setMaps(list);
        // Default the picker to the only map, if there's exactly one
        setAssignMapId((prev) =>
          prev && list.some((m) => m.id === prev) ? prev : list.length === 1 ? list[0].id : ""
        );
      } catch (err) {
        console.error("Failed to load maps:", err);
      }
    }
    loadMaps();
  }, [cityId]);

  // Handle GeoJSON file upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const geojson = JSON.parse(text);

      if (!geojson.features || !Array.isArray(geojson.features)) {
        setMessage("Error: File doesn't look like valid GeoJSON (no features array).");
        return;
      }

      // Try to detect the district number property name
      const firstProps = geojson.features[0]?.properties || {};
      const possibleKeys = Object.keys(firstProps);
      // Common names for district number in municipal GeoJSON files
      const districtKey = possibleKeys.find((k) =>
        /dist|district|ward|number|id|coun/i.test(k)
      );

      const newZones: ZoneDraft[] = geojson.features.map(
        (feat: any, i: number) => {
          const num = districtKey
            ? parseInt(feat.properties[districtKey]) || i + 1
            : i + 1;

          // Get boundary — handle both Polygon and MultiPolygon
          let boundary = feat.geometry;
          if (feat.geometry.type === "MultiPolygon") {
            // Take the largest polygon (most coordinates)
            const rings = feat.geometry.coordinates;
            const largest = rings.reduce((a: any, b: any) =>
              a[0].length > b[0].length ? a : b
            );
            boundary = { type: "Polygon", coordinates: largest };
          }

          // Calculate center point
          const coords =
            boundary.coordinates[0] ||
            boundary.coordinates[0]?.[0] ||
            [];
          const lats = coords.map((c: number[]) => c[1]);
          const lngs = coords.map((c: number[]) => c[0]);
          const centerLat =
            lats.length > 0
              ? lats.reduce((a: number, b: number) => a + b) / lats.length
              : 0;
          const centerLng =
            lngs.length > 0
              ? lngs.reduce((a: number, b: number) => a + b) / lngs.length
              : 0;

          // Pull any name from properties
          const props = feat.properties || {};
          const nameKey = possibleKeys.find((k) => /name|label|title/i.test(k));
          const defaultName = nameKey ? props[nameKey] : `District ${num}`;

          return {
            id: `zone_district_${num}`,
            district_number: num,
            name: defaultName || `District ${num}`,
            city: cityId,
            boundary: boundary,
            center_lat: Math.round(centerLat * 1000000) / 1000000,
            center_lng: Math.round(centerLng * 1000000) / 1000000,
            // Read pre-filled metadata from feature properties if present.
            culture_tags: readTagList(props, [
              "culture_tags",
              "cultureTags",
              "culture",
              "tags",
            ]),
            transit_lines: readTagList(props, [
              "transit_lines",
              "transitLines",
              "transit",
              "subway_lines",
              "lines",
            ]),
            landmarks: readTagList(props, ["landmarks", "landmark"]),
            difficulty_rating: readDifficulty(props),
            isNew: true,
          };
        }
      );

      // Merge with existing zones (don't overwrite ones that already have metadata)
      const existingIds = new Set(zones.map((z) => z.id));
      const merged = [
        ...zones,
        ...newZones.filter((z) => !existingIds.has(z.id)),
      ];
      merged.sort((a, b) => a.district_number - b.district_number);

      setZones(merged);
      setMessage(
        `Loaded ${newZones.length} districts from file. ${
          newZones.filter((z) => !existingIds.has(z.id)).length
        } new zones added. Fill in the metadata below and hit Save.`
      );
    } catch (err) {
      setMessage("Error reading file: " + (err as Error).message);
    }
  };

  // Update a zone field
  const updateZone = (id: string, field: string, value: any) => {
    setZones((prev) =>
      prev.map((z) => (z.id === id ? { ...z, [field]: value } : z))
    );
  };

  // Delete a zone
  const removeZone = async (id: string) => {
    if (!confirm(`Delete this zone? This removes it from Firestore too.`)) return;
    try {
      await deleteDoc(doc(db, "zones", id));
      setZones((prev) => prev.filter((z) => z.id !== id));
      setMessage("Zone deleted.");
    } catch (err) {
      setMessage("Error deleting: " + (err as Error).message);
    }
  };

  // Save all zones to Firestore
  const saveAll = async () => {
    // Every zone must belong to a map. Zones without one get the picked map;
    // if any zone still has no map, block the save rather than create orphans.
    const zonesMissingMap = zones.filter((z) => !z.map_id);
    if (zonesMissingMap.length > 0 && !assignMapId) {
      setMessage(
        `Pick a map to assign the ${zonesMissingMap.length} unassigned zone(s) before saving.`
      );
      return;
    }

    setSaving(true);
    setMessage("Saving...");
    try {
      for (const zone of zones) {
        // Keep an existing map_id; otherwise assign the picked map. merge:true
        // preserves map_id (and other unlisted fields) rather than stripping them.
        const effectiveMapId = zone.map_id || assignMapId;
        const mapIdField = effectiveMapId ? { map_id: effectiveMapId } : {};
        await setDoc(doc(db, "zones", zone.id), {
          id: zone.id,
          ...mapIdField,
          district_number: zone.district_number,
          name: zone.name,
          city: zone.city,
          boundary: JSON.stringify(zone.boundary),
          center_lat: zone.center_lat,
          center_lng: zone.center_lng,
          culture_tags: zone.culture_tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean),
          transit_lines: zone.transit_lines
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean),
          landmarks: zone.landmarks
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean),
          difficulty_rating: zone.difficulty_rating,
        }, { merge: true });
      }

      // Update city document with all zone IDs
      await setDoc(doc(db, "cities", cityId), {
        id: cityId,
        name: cityName,
        country: "US",
        default_zones: zones.map((z) => z.id),
        map_center: {
          lat: zones.length > 0 ? zones[0].center_lat : 40.7128,
          lng: zones.length > 0 ? zones[0].center_lng : -74.006,
          zoom: 12,
        },
        transit_system: "Subway",
        language: "en",
        currency: "USD",
        is_active: true,
      });

      setMessage(`Saved ${zones.length} zones + city config to Firestore.`);
      // Clear the "new" flag and reflect any just-assigned map_id
      setZones((prev) =>
        prev.map((z) => ({ ...z, map_id: z.map_id || assignMapId, isNew: false }))
      );
    } catch (err) {
      setMessage("Error saving: " + (err as Error).message);
    }
    setSaving(false);
  };

  // Toggle a zone in/out of the "save as map" selection.
  const toggleForMap = (id: string) => {
    setSelectedForMap((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bundle the checked zones into a NEW map: writes those zone docs (assigned to
  // the map via map_id) and creates a `maps` doc — the collection CreateGame's
  // picker reads. Center = average of the selected zones' centers; zoom default.
  const saveAsMap = async () => {
    const name = mapName.trim();
    if (!name) {
      setMessage("Error: give the map a name first.");
      return;
    }
    const selected = zones.filter((z) => selectedForMap.has(z.id));
    if (selected.length === 0) {
      setMessage("Error: select at least one zone for the map.");
      return;
    }

    setSavingMap(true);
    setMessage("Creating map...");
    try {
      const mapId = `map_${slugify(name)}_${Date.now().toString(36)}`;

      // Center = average of the selected zones' centers (matches SeedMaps'
      // map_center object shape). default_zoom is a fixed sensible default.
      const avgLat =
        selected.reduce((s, z) => s + (z.center_lat || 0), 0) / selected.length;
      const avgLng =
        selected.reduce((s, z) => s + (z.center_lng || 0), 0) / selected.length;
      const map_center = {
        lat: Math.round(avgLat * 1e6) / 1e6,
        lng: Math.round(avgLng * 1e6) / 1e6,
        zoom: 12,
      };

      // Write the selected zones (full docs) assigned to the new map. Covers
      // both freshly-uploaded zones and ones already saved.
      for (const zone of selected) {
        await setDoc(
          doc(db, "zones", zone.id),
          {
            id: zone.id,
            map_id: mapId,
            district_number: zone.district_number,
            name: zone.name,
            city: zone.city,
            boundary:
              typeof zone.boundary === "string"
                ? zone.boundary
                : JSON.stringify(zone.boundary),
            center_lat: zone.center_lat,
            center_lng: zone.center_lng,
            culture_tags: zone.culture_tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean),
            transit_lines: zone.transit_lines
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean),
            landmarks: zone.landmarks
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean),
            difficulty_rating: zone.difficulty_rating,
          },
          { merge: true }
        );
      }

      // Create the `maps` doc (same shape SeedMaps writes). is_active:true so it
      // appears in CreateGame's picker immediately.
      const mapDoc: Record<string, unknown> = {
        id: mapId,
        name,
        city: cityId,
        map_center,
        is_active: true,
        created_at: new Date(),
      };
      if (mapBorough.trim()) mapDoc.borough = mapBorough.trim();
      if (mapDesc.trim()) mapDoc.description = mapDesc.trim();
      await setDoc(doc(db, "maps", mapId), mapDoc);

      // Reflect locally: the selected zones now belong to the new map, and the
      // map joins the picker lists.
      setZones((prev) =>
        prev.map((z) =>
          selectedForMap.has(z.id) ? { ...z, map_id: mapId, isNew: false } : z
        )
      );
      setMaps((prev) =>
        [...prev, { id: mapId, name }].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setSelectedForMap(new Set());
      setMapName("");
      setMapBorough("");
      setMapDesc("");
      setMessage(
        `Created map "${name}" with ${selected.length} zone${
          selected.length === 1 ? "" : "s"
        }. It's now selectable in Create Game.`
      );
    } catch (err) {
      setMessage("Error creating map: " + (err as Error).message);
    }
    setSavingMap(false);
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--paper)",
          color: "var(--ink)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Loading zones...
      </div>
    );
  }

  // Zones shown in the list: all, or scoped to the selected filter map.
  const visibleZones = filterMapId
    ? zones.filter((z) => z.map_id === filterMapId)
    : zones;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--paper)",
        color: "var(--ink)",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        padding: "24px",
      }}
    >
      <div style={{ maxWidth: 700, margin: "0 auto" }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 4 }}>
          Zone Manager
        </h1>
        <p style={{ color: "var(--ink-muted)", marginBottom: 8, fontSize: "0.9rem" }}>
          Upload a GeoJSON file to add zones, fill in metadata, then save to
          Firestore. No code needed.
        </p>
        <button
          onClick={() => navigate("/admin/zone-builder")}
          style={{
            background: "none",
            border: "none",
            color: "var(--blue)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: "0.85rem",
            fontWeight: 600,
            padding: 0,
            marginBottom: 24,
          }}
        >
          Draw or edit zones in Zone Builder →
        </button>

        {/* City config */}
        <div
          style={{
            display: "flex",
            gap: 12,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          <div>
            <label
              style={{
                fontSize: "0.75rem",
                color: "var(--ink-muted)",
                display: "block",
                marginBottom: 4,
              }}
            >
              City ID
            </label>
            <input
              value={cityId}
              onChange={(e) => setCityId(e.target.value.toLowerCase())}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--line-strong)",
                color: "var(--ink)",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: "0.9rem",
                width: 140,
              }}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: "0.75rem",
                color: "var(--ink-muted)",
                display: "block",
                marginBottom: 4,
              }}
            >
              City Name
            </label>
            <input
              value={cityName}
              onChange={(e) => setCityName(e.target.value)}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--line-strong)",
                color: "var(--ink)",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: "0.9rem",
                width: 200,
              }}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: "0.75rem",
                color: "var(--ink-muted)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Assign new zones to map
            </label>
            <select
              value={assignMapId}
              onChange={(e) => setAssignMapId(e.target.value)}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--line-strong)",
                color: assignMapId ? "var(--ink)" : "var(--ink-muted)",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: "0.9rem",
                width: 240,
              }}
            >
              <option value="">
                {maps.length === 0 ? "No maps for this city" : "Select a map…"}
              </option>
              {maps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <p style={{ color: "var(--ink-faint)", fontSize: "0.72rem", marginTop: 4, maxWidth: 240 }}>
              Applied to zones that don't already belong to a map. Existing zones keep theirs.
            </p>
          </div>
        </div>

        {/* Upload */}
        <div
          style={{
            background: "var(--surface)",
            border: "2px dashed var(--line-strong)",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
            marginBottom: 20,
          }}
        >
          <p style={{ color: "var(--ink-muted)", marginBottom: 12, fontSize: "0.9rem" }}>
            Upload a GeoJSON file with district/neighborhood boundaries
          </p>
          <input
            type="file"
            accept=".geojson,.json"
            onChange={handleFileUpload}
            style={{ color: "var(--ink-muted)" }}
          />
        </div>

        {/* Status message */}
        {message && (
          <div
            style={{
              background: message.startsWith("Error")
                ? "rgba(var(--red-rgb), 0.1)"
                : "rgba(var(--green-rgb), 0.1)",
              border: `1px solid ${
                message.startsWith("Error")
                  ? "rgba(var(--red-rgb), 0.3)"
                  : "rgba(var(--green-rgb), 0.3)"
              }`,
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 20,
              color: message.startsWith("Error") ? "var(--red)" : "var(--green)",
              fontSize: "0.88rem",
            }}
          >
            {message}
          </div>
        )}

        {/* Filter which map's zones to show */}
        <div style={{ marginBottom: 12 }}>
          <label
            style={{
              fontSize: "0.75rem",
              color: "var(--ink-muted)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Show zones for map
          </label>
          <select
            value={filterMapId}
            onChange={(e) => setFilterMapId(e.target.value)}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--line-strong)",
              color: "var(--ink)",
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: "0.9rem",
              width: 280,
              maxWidth: "100%",
            }}
          >
            <option value="">All maps ({zones.length})</option>
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({zones.filter((z) => z.map_id === m.id).length})
              </option>
            ))}
          </select>
        </div>

        {/* Zone count + save button */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <span style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
            Showing {visibleZones.length} of {zones.length} zones
          </span>
          <button
            onClick={saveAll}
            disabled={saving || zones.length === 0}
            style={{
              background: saving ? "var(--line-strong)" : "var(--green)",
              color: saving ? "var(--ink-muted)" : "var(--paper)",
              border: "none",
              borderRadius: 8,
              padding: "10px 24px",
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
              fontSize: "0.9rem",
            }}
          >
            {saving ? "Saving..." : "Save All to Firestore"}
          </button>
        </div>

        {/* Save selected zones as a new map */}
        {zones.length > 0 && (
          <div
            style={{
              background: "rgba(var(--pink-rgb), 0.06)",
              border: "1px solid rgba(var(--pink-rgb), 0.3)",
              borderRadius: 12,
              padding: 16,
              marginBottom: 20,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              Save selected zones as a new map
            </div>
            <p style={{ color: "var(--ink-muted)", fontSize: "0.8rem", marginBottom: 12 }}>
              Check zones below, name the map, and save. It becomes a picker card
              in Create Game (writes a <code>maps</code> doc + sets each zone's{" "}
              <code>map_id</code>).
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <input
                value={mapName}
                onChange={(e) => setMapName(e.target.value)}
                placeholder="Map name (e.g. Manhattan Alpha)"
                style={{ ...inputStyle, flex: 1, width: "auto", minWidth: 200 }}
              />
              <input
                value={mapBorough}
                onChange={(e) => setMapBorough(e.target.value)}
                placeholder="Borough (optional)"
                style={{ ...inputStyle, width: 180 }}
              />
            </div>
            <input
              value={mapDesc}
              onChange={(e) => setMapDesc(e.target.value)}
              placeholder="Description (optional — shown on the picker card)"
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 12 }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  color: selectedForMap.size > 0 ? "var(--pink)" : "var(--ink-muted)",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                }}
              >
                {selectedForMap.size} zone{selectedForMap.size === 1 ? "" : "s"} selected
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() =>
                    setSelectedForMap(new Set(visibleZones.map((z) => z.id)))
                  }
                  style={ghostBtn}
                >
                  Select shown
                </button>
                <button onClick={() => setSelectedForMap(new Set())} style={ghostBtn}>
                  Clear
                </button>
                <button
                  onClick={saveAsMap}
                  disabled={savingMap || selectedForMap.size === 0 || !mapName.trim()}
                  style={{
                    background:
                      savingMap || selectedForMap.size === 0 || !mapName.trim()
                        ? "var(--line-strong)"
                        : "var(--pink)",
                    color:
                      savingMap || selectedForMap.size === 0 || !mapName.trim()
                        ? "var(--ink-muted)"
                        : "var(--ink)",
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 18px",
                    fontWeight: 700,
                    fontSize: "0.85rem",
                    cursor:
                      savingMap || selectedForMap.size === 0 || !mapName.trim()
                        ? "not-allowed"
                        : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {savingMap ? "Saving…" : "Save as map"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Zone list */}
        {visibleZones.map((zone) => (
          <div
            key={zone.id}
            style={{
              background: zone.isNew
                ? "rgba(var(--marigold-rgb), 0.05)"
                : "rgba(var(--ink-rgb), 0.02)",
              border: `1px solid ${zone.isNew ? "#FFD16640" : "var(--line)"}`,
              borderRadius: 12,
              marginBottom: 10,
              overflow: "hidden",
            }}
          >
            {/* Zone header — checkbox bundles into a new map; click to expand */}
            <div style={{ display: "flex", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={selectedForMap.has(zone.id)}
                onChange={() => toggleForMap(zone.id)}
                title="Include this zone in the new map"
                style={{
                  margin: "0 0 0 16px",
                  width: 16,
                  height: 16,
                  cursor: "pointer",
                  accentColor: "var(--pink)",
                  flexShrink: 0,
                }}
              />
              <button
                onClick={() =>
                  setExpandedZone(expandedZone === zone.id ? null : zone.id)
                }
                style={{
                  width: "100%",
                  padding: "14px 16px",
                background: "none",
                border: "none",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontFamily: "inherit",
              }}
            >
              <div style={{ textAlign: "left" }}>
                <span
                  style={{
                    color: "var(--marigold)",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                  }}
                >
                  #{zone.district_number}
                </span>
                <span style={{ color: "var(--ink)", marginLeft: 10, fontWeight: 600 }}>
                  {zone.name}
                </span>
                {zone.isNew && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: "0.7rem",
                      color: "var(--marigold)",
                      background: "rgba(var(--marigold-rgb), 0.15)",
                      padding: "2px 8px",
                      borderRadius: 4,
                    }}
                  >
                    NEW
                  </span>
                )}
                {(() => {
                  // Show the zone's map: its own, or the one it'll be assigned on save.
                  const mid = zone.map_id || (assignMapId || "");
                  const label = mid
                    ? maps.find((m) => m.id === mid)?.name || mid
                    : "no map";
                  const pending = !zone.map_id && !!assignMapId;
                  return (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "0.7rem",
                        color: mid ? "var(--green)" : "var(--red)",
                        background: mid ? "rgba(var(--green-rgb), 0.12)" : "rgba(var(--red-rgb), 0.12)",
                        padding: "2px 8px",
                        borderRadius: 4,
                      }}
                    >
                      🗺 {label}{pending ? " (on save)" : ""}
                    </span>
                  );
                })()}
              </div>
              <span
                style={{
                  color: "var(--ink-faint)",
                  transform:
                    expandedZone === zone.id ? "rotate(180deg)" : "none",
                  transition: "0.2s",
                }}
              >
                ▼
              </span>
            </button>
            </div>

            {/* Expanded edit form */}
            {expandedZone === zone.id && (
              <div
                style={{
                  padding: "0 16px 16px",
                  display: "grid",
                  gap: 12,
                }}
              >
                <div>
                  <label style={labelStyle}>Zone Name</label>
                  <input
                    value={zone.name}
                    onChange={(e) => updateZone(zone.id, "name", e.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    Culture Tags (comma-separated)
                  </label>
                  <input
                    value={zone.culture_tags}
                    onChange={(e) =>
                      updateZone(zone.id, "culture_tags", e.target.value)
                    }
                    placeholder="caribbean, haitian, food, art"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    Transit Lines (comma-separated)
                  </label>
                  <input
                    value={zone.transit_lines}
                    onChange={(e) =>
                      updateZone(zone.id, "transit_lines", e.target.value)
                    }
                    placeholder="2, 5, B44"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    Landmarks (comma-separated)
                  </label>
                  <input
                    value={zone.landmarks}
                    onChange={(e) =>
                      updateZone(zone.id, "landmarks", e.target.value)
                    }
                    placeholder="Prospect Park, Brooklyn Museum"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    Difficulty (1=easy walking, 5=spread out/hard)
                  </label>
                  <select
                    value={zone.difficulty_rating}
                    onChange={(e) =>
                      updateZone(
                        zone.id,
                        "difficulty_rating",
                        parseInt(e.target.value)
                      )
                    }
                    style={{
                      ...inputStyle,
                      width: 80,
                    }}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingTop: 8,
                  }}
                >
                  <span style={{ color: "var(--ink-faint)", fontSize: "0.75rem" }}>
                    Center: {zone.center_lat.toFixed(4)},{" "}
                    {zone.center_lng.toFixed(4)}
                  </span>
                  <button
                    onClick={() => removeZone(zone.id)}
                    style={{
                      background: "rgba(var(--red-rgb), 0.1)",
                      color: "var(--red)",
                      border: "1px solid rgba(var(--red-rgb), 0.3)",
                      borderRadius: 6,
                      padding: "6px 14px",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    Delete Zone
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--ink-muted)",
  display: "block",
  marginBottom: 4,
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--line-strong)",
  color: "var(--ink)",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: "0.88rem",
  width: "100%",
  boxSizing: "border-box",
};

const ghostBtn: React.CSSProperties = {
  background: "rgba(var(--ink-rgb), 0.03)",
  border: "1px solid var(--line-strong)",
  color: "var(--ink-muted)",
  borderRadius: 8,
  padding: "9px 14px",
  fontWeight: 600,
  fontSize: "0.82rem",
  cursor: "pointer",
  fontFamily: "inherit",
};