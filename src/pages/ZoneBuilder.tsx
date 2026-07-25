// =============================================================================
// Zone Builder (admin/GM only)
// Click-and-drag polygon drawing on a Mapbox map, writing directly into the
// maps/zones Firestore structure. Flow: open/create a map → draw its outer
// boundary → draw zones (name + tags) → save → publish.
//
// Gated by AdminGuard in App.tsx (admin/gm roles only). Firestore rules already
// restrict maps/zones writes to admin/GM, so no rules change is needed.
//
// Built in steps. This is step 2: pick a city, open an existing map, and render
// its saved zones + boundary read-only. Drawing/validation land in later steps.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import bbox from "@turf/bbox";
import { db } from "../lib/firebase";
import type { Zone } from "../types/game";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

interface MapOption {
  id: string;
  name: string;
  boundary?: string; // GeoJSON string, if this map has an outer frame drawn
  is_active?: boolean;
  map_center?: { lat: number; lng: number; zoom: number };
}

// Source/layer ids we manage on the map.
const SRC_ZONES = "zb-saved-zones";
const SRC_ZONE_LABELS = "zb-zone-labels";
const SRC_BOUNDARY = "zb-map-boundary";

export default function ZoneBuilder() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [cityId, setCityId] = useState("nyc");
  const [maps, setMaps] = useState<MapOption[]>([]);
  const [selectedMapId, setSelectedMapId] = useState("");
  const [zones, setZones] = useState<Zone[]>([]);
  const [loadingMaps, setLoadingMaps] = useState(false);
  const [loadingZones, setLoadingZones] = useState(false);
  const [message, setMessage] = useState("");

  const selectedMap = maps.find((m) => m.id === selectedMapId) || null;

  // ---- Load maps for the current city ----
  useEffect(() => {
    let cancelled = false;
    async function loadMaps() {
      setLoadingMaps(true);
      try {
        const snap = await getDocs(
          query(collection(db, "maps"), where("city", "==", cityId))
        );
        if (cancelled) return;
        const list: MapOption[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: (data.name as string) || d.id,
            boundary: data.boundary,
            is_active: data.is_active,
            map_center: data.map_center,
          };
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        setMaps(list);
      } catch (err) {
        setMessage("Error loading maps: " + (err as Error).message);
      } finally {
        if (!cancelled) setLoadingMaps(false);
      }
    }
    loadMaps();
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  // ---- Load zones for the selected map ----
  useEffect(() => {
    let cancelled = false;
    async function loadZones() {
      if (!selectedMapId) {
        setZones([]);
        return;
      }
      setLoadingZones(true);
      try {
        const snap = await getDocs(
          query(collection(db, "zones"), where("map_id", "==", selectedMapId))
        );
        if (cancelled) return;
        const list = snap.docs.map((d) => ({ ...(d.data() as Zone), id: d.id }));
        setZones(list);
      } catch (err) {
        setMessage("Error loading zones: " + (err as Error).message);
      } finally {
        if (!cancelled) setLoadingZones(false);
      }
    }
    loadZones();
    return () => {
      cancelled = true;
    };
  }, [selectedMapId]);

  // ---- Initialize the Mapbox map once ----
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-73.95, 40.7],
      zoom: 11,
    });

    map.current.on("load", () => {
      if (!map.current) return;

      // Boundary (map outer frame) — drawn beneath zones.
      map.current.addSource(SRC_BOUNDARY, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_BOUNDARY}-fill`,
        type: "fill",
        source: SRC_BOUNDARY,
        paint: { "fill-color": "#FFD166", "fill-opacity": 0.04 },
      });
      map.current.addLayer({
        id: `${SRC_BOUNDARY}-line`,
        type: "line",
        source: SRC_BOUNDARY,
        paint: {
          "line-color": "#FFD166",
          "line-width": 2,
          "line-dasharray": [3, 2],
        },
      });

      // Saved zones — fill + border.
      map.current.addSource(SRC_ZONES, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_ZONES}-fill`,
        type: "fill",
        source: SRC_ZONES,
        paint: { "fill-color": "#4C9AFF", "fill-opacity": 0.18 },
      });
      map.current.addLayer({
        id: `${SRC_ZONES}-line`,
        type: "line",
        source: SRC_ZONES,
        paint: { "line-color": "#4C9AFF", "line-width": 1.5 },
      });

      // Zone labels at each zone's stored center.
      map.current.addSource(SRC_ZONE_LABELS, {
        type: "geojson",
        data: emptyFC(),
      });
      map.current.addLayer({
        id: `${SRC_ZONE_LABELS}-symbol`,
        type: "symbol",
        source: SRC_ZONE_LABELS,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 13,
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-max-width": 8,
        },
        paint: {
          "text-color": "#cfe4ff",
          "text-halo-color": "#000000",
          "text-halo-width": 1,
        },
      });

      setMapReady(true);
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // ---- Push zones + boundary onto the map whenever they change ----
  useEffect(() => {
    if (!mapReady || !map.current) return;

    // Zones → polygon features + label points.
    const zoneFeatures: GeoJSON.Feature[] = [];
    const labelFeatures: GeoJSON.Feature[] = [];
    for (const z of zones) {
      const geom = parseGeometry(z.boundary);
      if (!geom) continue;
      zoneFeatures.push({
        type: "Feature",
        properties: { id: z.id, name: z.name },
        geometry: geom,
      });
      if (typeof z.center_lng === "number" && typeof z.center_lat === "number") {
        labelFeatures.push({
          type: "Feature",
          properties: { name: z.name },
          geometry: { type: "Point", coordinates: [z.center_lng, z.center_lat] },
        });
      }
    }
    (map.current.getSource(SRC_ZONES) as mapboxgl.GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: zoneFeatures,
    });
    (map.current.getSource(SRC_ZONE_LABELS) as mapboxgl.GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: labelFeatures,
    });

    // Boundary.
    const boundaryGeom = selectedMap?.boundary
      ? parseGeometry(selectedMap.boundary)
      : null;
    (map.current.getSource(SRC_BOUNDARY) as mapboxgl.GeoJSONSource)?.setData(
      boundaryGeom
        ? {
            type: "Feature",
            properties: {},
            geometry: boundaryGeom,
          }
        : emptyFC()
    );

    // Fit to whatever we have (boundary first, else zones).
    const fitFeatures = boundaryGeom
      ? [{ type: "Feature", properties: {}, geometry: boundaryGeom }]
      : zoneFeatures;
    if (fitFeatures.length > 0) {
      try {
        const [minX, minY, maxX, maxY] = bbox({
          type: "FeatureCollection",
          features: fitFeatures as GeoJSON.Feature[],
        });
        map.current.fitBounds(
          [
            [minX, minY],
            [maxX, maxY],
          ],
          { padding: 60, duration: 600, maxZoom: 15 }
        );
      } catch {
        /* ignore malformed geometry */
      }
    }
  }, [zones, selectedMap, mapReady]);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#0a0a0a",
        color: "#fff",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {/* Control panel */}
      <div
        style={{
          width: 320,
          minWidth: 320,
          borderRight: "1px solid #1a1a1a",
          padding: 20,
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 800, marginBottom: 4 }}>
          Zone Builder
        </h1>
        <p style={{ color: "#888", fontSize: "0.82rem", marginBottom: 20 }}>
          Open a map to see its zones and boundary. Drawing comes next.
        </p>

        <label style={labelStyle}>City</label>
        <input
          value={cityId}
          onChange={(e) => setCityId(e.target.value.toLowerCase())}
          style={inputStyle}
        />

        <label style={{ ...labelStyle, marginTop: 16 }}>Map</label>
        <select
          value={selectedMapId}
          onChange={(e) => setSelectedMapId(e.target.value)}
          style={{ ...inputStyle, color: selectedMapId ? "#fff" : "#888" }}
        >
          <option value="">
            {loadingMaps
              ? "Loading maps…"
              : maps.length === 0
              ? "No maps for this city"
              : "Select a map…"}
          </option>
          {maps.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.is_active ? " • published" : ""}
            </option>
          ))}
        </select>

        {selectedMap && (
          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              background: "rgba(255,255,255,0.02)",
              border: "1px solid #1a1a1a",
              borderRadius: 10,
              fontSize: "0.82rem",
            }}
          >
            <div style={{ color: "#888", marginBottom: 6 }}>
              {loadingZones ? "Loading zones…" : `${zones.length} zone(s)`}
            </div>
            <div style={{ color: selectedMap.boundary ? "#06D6A0" : "#EF476F" }}>
              {selectedMap.boundary
                ? "✓ boundary set"
                : "no boundary drawn yet"}
            </div>
          </div>
        )}

        {message && (
          <div
            style={{
              marginTop: 16,
              background: message.startsWith("Error")
                ? "rgba(239,71,111,0.1)"
                : "rgba(6,214,160,0.1)",
              border: `1px solid ${
                message.startsWith("Error")
                  ? "rgba(239,71,111,0.3)"
                  : "rgba(6,214,160,0.3)"
              }`,
              borderRadius: 8,
              padding: "10px 12px",
              color: message.startsWith("Error") ? "#EF476F" : "#06D6A0",
              fontSize: "0.82rem",
            }}
          >
            {message}
          </div>
        )}
      </div>

      {/* Map */}
      <div ref={mapContainer} style={{ flex: 1, height: "100%" }} />
    </div>
  );
}

// --------------- Helpers ---------------

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// Zone/map boundaries are stored as JSON strings (sometimes already-parsed
// objects on freshly-written docs). Return a usable geometry or null.
function parseGeometry(raw: unknown): GeoJSON.Geometry | null {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && (obj.type === "Polygon" || obj.type === "MultiPolygon")) {
      return obj as GeoJSON.Geometry;
    }
    return null;
  } catch {
    return null;
  }
}

const labelStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "#888",
  display: "block",
  marginBottom: 6,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

const inputStyle: React.CSSProperties = {
  background: "#111",
  border: "1px solid #333",
  color: "#fff",
  padding: "9px 12px",
  borderRadius: 8,
  fontSize: "0.88rem",
  width: "100%",
  boxSizing: "border-box",
};
