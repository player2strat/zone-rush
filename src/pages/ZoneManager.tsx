import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "../lib/firebase";

interface ZoneDraft {
  id: string;
  district_number: number;
  name: string;
  city: string;
  boundary: any;
  center_lat: number;
  center_lng: number;
  culture_tags: string;
  transit_lines: string;
  landmarks: string;
  difficulty_rating: number;
  isNew?: boolean;
}

export default function ZoneManager() {
  const [zones, setZones] = useState<ZoneDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [expandedZone, setExpandedZone] = useState<string | null>(null);
  const [cityId, setCityId] = useState("nyc");
  const [cityName, setCityName] = useState("New York City");

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
          const nameKey = possibleKeys.find((k) => /name|label|title/i.test(k));
          const defaultName = nameKey
            ? feat.properties[nameKey]
            : `District ${num}`;

          return {
            id: `zone_district_${num}`,
            district_number: num,
            name: defaultName || `District ${num}`,
            city: cityId,
            boundary: boundary,
            center_lat: Math.round(centerLat * 1000000) / 1000000,
            center_lng: Math.round(centerLng * 1000000) / 1000000,
            culture_tags: "",
            transit_lines: "",
            landmarks: "",
            difficulty_rating: 3,
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
    setSaving(true);
    setMessage("Saving...");
    try {
      for (const zone of zones) {
        await setDoc(doc(db, "zones", zone.id), {
          id: zone.id,
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
        });
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
      // Clear the "new" flag
      setZones((prev) => prev.map((z) => ({ ...z, isNew: false })));
    } catch (err) {
      setMessage("Error saving: " + (err as Error).message);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0a0a0a",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Loading zones...
      </div>
    );
  }

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
      <div style={{ maxWidth: 700, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 4 }}>
          Zone Manager
        </h1>
        <p style={{ color: "#888", marginBottom: 24, fontSize: "0.9rem" }}>
          Upload a GeoJSON file to add zones, fill in metadata, then save to
          Firestore. No code needed.
        </p>

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
                color: "#666",
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
                background: "#111",
                border: "1px solid #333",
                color: "#fff",
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
                color: "#666",
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
                background: "#111",
                border: "1px solid #333",
                color: "#fff",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: "0.9rem",
                width: 200,
              }}
            />
          </div>
        </div>

        {/* Upload */}
        <div
          style={{
            background: "#111",
            border: "2px dashed #333",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
            marginBottom: 20,
          }}
        >
          <p style={{ color: "#aaa", marginBottom: 12, fontSize: "0.9rem" }}>
            Upload a GeoJSON file with district/neighborhood boundaries
          </p>
          <input
            type="file"
            accept=".geojson,.json"
            onChange={handleFileUpload}
            style={{ color: "#888" }}
          />
        </div>

        {/* Status message */}
        {message && (
          <div
            style={{
              background: message.startsWith("Error")
                ? "rgba(239,71,111,0.1)"
                : "rgba(6,214,160,0.1)",
              border: `1px solid ${
                message.startsWith("Error")
                  ? "rgba(239,71,111,0.3)"
                  : "rgba(6,214,160,0.3)"
              }`,
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 20,
              color: message.startsWith("Error") ? "#EF476F" : "#06D6A0",
              fontSize: "0.88rem",
            }}
          >
            {message}
          </div>
        )}

        {/* Zone count + save button */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <span style={{ color: "#888", fontSize: "0.85rem" }}>
            {zones.length} zones loaded
          </span>
          <button
            onClick={saveAll}
            disabled={saving || zones.length === 0}
            style={{
              background: saving ? "#333" : "#06D6A0",
              color: saving ? "#888" : "#000",
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

        {/* Zone list */}
        {zones.map((zone) => (
          <div
            key={zone.id}
            style={{
              background: zone.isNew
                ? "rgba(255,209,102,0.05)"
                : "rgba(255,255,255,0.02)",
              border: `1px solid ${zone.isNew ? "#FFD16640" : "#1a1a1a"}`,
              borderRadius: 12,
              marginBottom: 10,
              overflow: "hidden",
            }}
          >
            {/* Zone header — click to expand */}
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
                    color: "#FFD166",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                  }}
                >
                  #{zone.district_number}
                </span>
                <span style={{ color: "#fff", marginLeft: 10, fontWeight: 600 }}>
                  {zone.name}
                </span>
                {zone.isNew && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: "0.7rem",
                      color: "#FFD166",
                      background: "rgba(255,209,102,0.15)",
                      padding: "2px 8px",
                      borderRadius: 4,
                    }}
                  >
                    NEW
                  </span>
                )}
              </div>
              <span
                style={{
                  color: "#555",
                  transform:
                    expandedZone === zone.id ? "rotate(180deg)" : "none",
                  transition: "0.2s",
                }}
              >
                ▼
              </span>
            </button>

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
                  <span style={{ color: "#555", fontSize: "0.75rem" }}>
                    Center: {zone.center_lat.toFixed(4)},{" "}
                    {zone.center_lng.toFixed(4)}
                  </span>
                  <button
                    onClick={() => removeZone(zone.id)}
                    style={{
                      background: "rgba(239,71,111,0.1)",
                      color: "#EF476F",
                      border: "1px solid rgba(239,71,111,0.3)",
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
  color: "#888",
  display: "block",
  marginBottom: 4,
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  background: "#111",
  border: "1px solid #333",
  color: "#fff",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: "0.88rem",
  width: "100%",
  boxSizing: "border-box",
};