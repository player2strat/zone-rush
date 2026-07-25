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

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import bbox from "@turf/bbox";
import center from "@turf/center";
import intersect from "@turf/intersect";
import union from "@turf/union";
import difference from "@turf/difference";
import area from "@turf/area";
import { db } from "../lib/firebase";
import type { Zone } from "../types/game";

// Overlap smaller than this (square meters) is treated as a drawing-imprecision
// sliver along a shared border, not a real double-covered area, and is ignored.
const OVERLAP_TOLERANCE_SQM = 50;

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
const SRC_GAP = "zb-coverage-gap";

export default function ZoneBuilder() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  const drawTarget = useRef<"zone" | "boundary" | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const fittedMapRef = useRef<string>("");

  const [cityId, setCityId] = useState("nyc");
  const [maps, setMaps] = useState<MapOption[]>([]);
  const [selectedMapId, setSelectedMapId] = useState("");
  const [zones, setZones] = useState<Zone[]>([]);
  const [loadingMaps, setLoadingMaps] = useState(false);
  const [loadingZones, setLoadingZones] = useState(false);
  const [message, setMessage] = useState("");

  // Pending drawn zone awaiting metadata + save.
  const [pendingGeometry, setPendingGeometry] = useState<GeoJSON.Geometry | null>(null);
  const pendingDrawId = useRef<string | null>(null);
  const [zoneName, setZoneName] = useState("");
  const [cultureTags, setCultureTags] = useState("");
  const [landmarks, setLandmarks] = useState("");
  const [transit, setTransit] = useState("");
  const [difficulty, setDifficulty] = useState(3);
  const [saving, setSaving] = useState(false);
  const [overrideOverlap, setOverrideOverlap] = useState(false);

  // Pending map-boundary awaiting confirmation.
  const [pendingBoundary, setPendingBoundary] = useState<GeoJSON.Geometry | null>(null);
  const pendingBoundaryDrawId = useRef<string | null>(null);
  const [savingBoundary, setSavingBoundary] = useState(false);

  const selectedMap = maps.find((m) => m.id === selectedMapId) || null;

  // Real (non-sliver) overlaps between the pending zone and each saved zone.
  const overlaps = useMemo(
    () => (pendingGeometry ? computeOverlaps(pendingGeometry, zones) : []),
    [pendingGeometry, zones]
  );

  // Coverage gap: the part of the map boundary not yet covered by any zone.
  const gapFeature = useMemo(() => {
    const b = selectedMap?.boundary ? parseGeometry(selectedMap.boundary) : null;
    if (!b) return null;
    return computeGap(b, zones);
  }, [selectedMap?.boundary, zones]);

  // Percent of the boundary still uncovered (null when no boundary).
  const gapPercent = useMemo(() => {
    const b = selectedMap?.boundary ? parseGeometry(selectedMap.boundary) : null;
    const bf = b ? toPolyFeature(b) : null;
    if (!bf) return null;
    const total = area(bf);
    if (total <= 0) return null;
    const gapArea = gapFeature ? area(gapFeature) : 0;
    return Math.max(0, Math.min(100, Math.round((gapArea / total) * 100)));
  }, [selectedMap?.boundary, gapFeature]);

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

      // Coverage gap — uncovered space inside the boundary. Drawn above zone
      // fills (but below labels) so gaps read clearly while drawing.
      map.current.addSource(SRC_GAP, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_GAP}-fill`,
        type: "fill",
        source: SRC_GAP,
        paint: { "fill-color": "#FF6B35", "fill-opacity": 0.3 },
      });
      map.current.addLayer({
        id: `${SRC_GAP}-line`,
        type: "line",
        source: SRC_GAP,
        paint: {
          "line-color": "#FF6B35",
          "line-width": 1,
          "line-dasharray": [2, 2],
        },
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

      // Polygon drawing. We drive modes from our own buttons, so hide the
      // default control UI. A finished polygon fires 'draw.create'.
      draw.current = new MapboxDraw({ displayControlsDefault: false });
      map.current.addControl(draw.current as unknown as mapboxgl.IControl);
      map.current.on("draw.create", handleDrawCreate as never);

      setMapReady(true);
    });

    return () => {
      map.current?.remove();
      map.current = null;
      draw.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A polygon was finished — route it to the zone form or the boundary confirm,
  // depending on which "draw" button started it. We keep the feature in the draw
  // layer (so the user sees it) until they save or cancel.
  function handleDrawCreate(e: { features: GeoJSON.Feature[] }) {
    const f = e.features?.[0];
    if (!f || !f.geometry) return;
    const target = drawTarget.current;
    drawTarget.current = null;
    if (target === "boundary") {
      pendingBoundaryDrawId.current = f.id != null ? String(f.id) : null;
      setPendingBoundary(f.geometry);
    } else {
      pendingDrawId.current = f.id != null ? String(f.id) : null;
      setPendingGeometry(f.geometry);
      setOverrideOverlap(false);
    }
    setMessage("");
  }

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

    // Fit to whatever we have (boundary first, else zones) — but only once per
    // map open, so the view doesn't jump every time a zone is saved.
    const fitFeatures = boundaryGeom
      ? [{ type: "Feature", properties: {}, geometry: boundaryGeom }]
      : zoneFeatures;
    if (
      selectedMapId &&
      fittedMapRef.current !== selectedMapId &&
      fitFeatures.length > 0
    ) {
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
        fittedMapRef.current = selectedMapId;
      } catch {
        /* ignore malformed geometry */
      }
    }
  }, [zones, selectedMap, selectedMapId, mapReady]);

  // ---- Push the coverage gap onto the map whenever it changes ----
  useEffect(() => {
    if (!mapReady || !map.current) return;
    (map.current.getSource(SRC_GAP) as mapboxgl.GeoJSONSource)?.setData(
      gapFeature ?? emptyFC()
    );
  }, [gapFeature, mapReady]);

  // ---- Drawing + saving zones ----

  function startDrawZone() {
    if (!selectedMapId) {
      setMessage("Error: pick a map first.");
      return;
    }
    cancelPending();
    cancelPendingBoundary();
    drawTarget.current = "zone";
    draw.current?.changeMode("draw_polygon");
    setMessage("Click to place points; double-click (or Enter) to finish.");
  }

  function startDrawBoundary() {
    if (!selectedMapId) {
      setMessage("Error: pick a map first.");
      return;
    }
    cancelPending();
    cancelPendingBoundary();
    drawTarget.current = "boundary";
    draw.current?.changeMode("draw_polygon");
    setMessage("Draw the map's outer frame; double-click (or Enter) to finish.");
  }

  function cancelPendingBoundary() {
    if (pendingBoundaryDrawId.current) {
      try {
        draw.current?.delete(pendingBoundaryDrawId.current);
      } catch {
        /* already gone */
      }
    }
    pendingBoundaryDrawId.current = null;
    setPendingBoundary(null);
  }

  async function saveBoundary() {
    if (!pendingBoundary || !selectedMapId) return;
    setSavingBoundary(true);
    try {
      const boundaryStr = JSON.stringify(pendingBoundary);
      await setDoc(
        doc(db, "maps", selectedMapId),
        { boundary: boundaryStr },
        { merge: true }
      );
      // Reflect locally so the boundary + coverage aid update immediately.
      setMaps((prev) =>
        prev.map((m) =>
          m.id === selectedMapId ? { ...m, boundary: boundaryStr } : m
        )
      );
      cancelPendingBoundary();
      setMessage("Map boundary saved.");
    } catch (err) {
      setMessage("Error saving boundary: " + (err as Error).message);
    }
    setSavingBoundary(false);
  }

  // Remove the pending drawn feature and reset the form.
  function cancelPending() {
    if (pendingDrawId.current) {
      try {
        draw.current?.delete(pendingDrawId.current);
      } catch {
        /* already gone */
      }
    }
    pendingDrawId.current = null;
    setPendingGeometry(null);
    setZoneName("");
    setCultureTags("");
    setLandmarks("");
    setTransit("");
    setDifficulty(3);
    setOverrideOverlap(false);
  }

  async function saveZone() {
    if (!pendingGeometry || !selectedMapId) return;
    // Block overlapping saves unless the user explicitly overrode.
    if (overlaps.length > 0 && !overrideOverlap) {
      setMessage(
        "Error: this zone overlaps an existing one. Fix it, or check 'save anyway'."
      );
      return;
    }
    setSaving(true);
    try {
      const c = center({ type: "Feature", properties: {}, geometry: pendingGeometry });
      const [lng, lat] = c.geometry.coordinates;
      const id = `zone_${selectedMapId}_${Date.now().toString(36)}${Math.floor(
        Math.random() * 1000
      )}`;
      const zoneDoc: Zone = {
        id,
        map_id: selectedMapId,
        name: zoneName.trim() || "Untitled zone",
        city: cityId,
        boundary: JSON.stringify(pendingGeometry),
        center_lat: Math.round(lat * 1e6) / 1e6,
        center_lng: Math.round(lng * 1e6) / 1e6,
        culture_tags: splitTags(cultureTags),
        transit_lines: splitTags(transit),
        landmarks: splitTags(landmarks),
        difficulty_rating: difficulty,
      };
      await setDoc(doc(db, "zones", id), zoneDoc);
      setZones((prev) => [...prev, zoneDoc]);
      const savedName = zoneDoc.name;
      cancelPending();
      setMessage(`Saved zone "${savedName}".`);
    } catch (err) {
      setMessage("Error saving zone: " + (err as Error).message);
    }
    setSaving(false);
  }

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
            {selectedMap.boundary && gapPercent !== null && (
              <div
                style={{
                  marginTop: 4,
                  color: gapPercent === 0 ? "#06D6A0" : "#FF6B35",
                }}
              >
                {gapPercent === 0
                  ? "✓ fully covered"
                  : `~${gapPercent}% uncovered (orange overlay)`}
              </div>
            )}
          </div>
        )}

        {/* Draw actions */}
        {selectedMap && !pendingGeometry && !pendingBoundary && (
          <>
            <button onClick={startDrawZone} style={primaryBtnStyle}>
              ✏️ Draw a zone
            </button>
            <button onClick={startDrawBoundary} style={secondaryFullBtnStyle}>
              {selectedMap.boundary
                ? "↺ Redraw map boundary"
                : "▢ Draw map boundary"}
            </button>
          </>
        )}

        {/* Boundary confirm */}
        {pendingBoundary && (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              background: "rgba(255,209,102,0.06)",
              border: "1px solid rgba(255,209,102,0.35)",
              borderRadius: 10,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Map boundary
            </div>
            <div
              style={{ color: "#c9b072", fontSize: "0.82rem", marginBottom: 14 }}
            >
              Save this shape as the map's outer frame? The coverage overlay
              measures gaps against it.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={saveBoundary}
                disabled={savingBoundary}
                style={{
                  ...primaryBtnStyle,
                  marginTop: 0,
                  flex: 1,
                  opacity: savingBoundary ? 0.6 : 1,
                  cursor: savingBoundary ? "not-allowed" : "pointer",
                }}
              >
                {savingBoundary ? "Saving…" : "Save boundary"}
              </button>
              <button
                onClick={cancelPendingBoundary}
                disabled={savingBoundary}
                style={secondaryBtnStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {pendingGeometry && (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              background: "rgba(76,154,255,0.06)",
              border: "1px solid rgba(76,154,255,0.3)",
              borderRadius: 10,
            }}
          >
            <div
              style={{ fontWeight: 700, marginBottom: 12, fontSize: "0.95rem" }}
            >
              New zone
            </div>

            <label style={labelStyle}>Zone name</label>
            <input
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              placeholder="e.g. Prospect Heights"
              style={inputStyle}
              autoFocus
            />

            <label style={{ ...labelStyle, marginTop: 12 }}>
              Culture tags (comma-separated)
            </label>
            <input
              value={cultureTags}
              onChange={(e) => setCultureTags(e.target.value)}
              placeholder="caribbean, food, art"
              style={inputStyle}
            />

            <label style={{ ...labelStyle, marginTop: 12 }}>
              Landmarks (comma-separated)
            </label>
            <input
              value={landmarks}
              onChange={(e) => setLandmarks(e.target.value)}
              placeholder="Prospect Park, Brooklyn Museum"
              style={inputStyle}
            />

            <label style={{ ...labelStyle, marginTop: 12 }}>
              Transit lines (comma-separated)
            </label>
            <input
              value={transit}
              onChange={(e) => setTransit(e.target.value)}
              placeholder="2, 3, B44"
              style={inputStyle}
            />

            <label style={{ ...labelStyle, marginTop: 12 }}>Difficulty</label>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(parseInt(e.target.value))}
              style={{ ...inputStyle, width: 90 }}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            {/* Overlap warning + override */}
            {overlaps.length > 0 && (
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 12px",
                  background: "rgba(239,71,111,0.1)",
                  border: "1px solid rgba(239,71,111,0.4)",
                  borderRadius: 8,
                  fontSize: "0.8rem",
                  color: "#EF476F",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  ⚠ Overlaps {overlaps.length} saved zone
                  {overlaps.length > 1 ? "s" : ""}
                </div>
                <div style={{ color: "#f2a6ba", lineHeight: 1.5 }}>
                  {overlaps
                    .map((o) => `${o.name} (${Math.round(o.areaSqM)} m²)`)
                    .join(", ")}
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 10,
                    color: "#f2a6ba",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={overrideOverlap}
                    onChange={(e) => setOverrideOverlap(e.target.checked)}
                  />
                  Save anyway (allow overlap)
                </label>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              {(() => {
                const blocked = overlaps.length > 0 && !overrideOverlap;
                const disabled = saving || blocked;
                return (
                  <button
                    onClick={saveZone}
                    disabled={disabled}
                    style={{
                      ...primaryBtnStyle,
                      marginTop: 0,
                      flex: 1,
                      background: blocked ? "#333" : primaryBtnStyle.background,
                      color: blocked ? "#888" : primaryBtnStyle.color,
                      opacity: saving ? 0.6 : 1,
                      cursor: disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    {saving ? "Saving…" : blocked ? "Overlap — blocked" : "Save zone"}
                  </button>
                );
              })()}
              <button
                onClick={cancelPending}
                disabled={saving}
                style={secondaryBtnStyle}
              >
                Cancel
              </button>
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

function splitTags(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

interface Overlap {
  id: string;
  name: string;
  areaSqM: number;
}

// Real (non-sliver) overlaps between a candidate polygon and each saved zone.
// A shared border is a line (zero area) and won't register; only genuine
// double-covered area above the tolerance is reported.
function computeOverlaps(
  pending: GeoJSON.Geometry,
  zones: Zone[]
): Overlap[] {
  const out: Overlap[] = [];
  const pendingFeature = toPolyFeature(pending);
  if (!pendingFeature) return out;
  for (const z of zones) {
    const zg = parseGeometry(z.boundary);
    const zf = zg ? toPolyFeature(zg) : null;
    if (!zf) continue;
    try {
      const inter = intersect({
        type: "FeatureCollection",
        features: [pendingFeature, zf],
      });
      if (inter) {
        const a = area(inter);
        if (a > OVERLAP_TOLERANCE_SQM) {
          out.push({ id: z.id, name: z.name, areaSqM: a });
        }
      }
    } catch {
      /* skip geometries turf can't intersect */
    }
  }
  return out;
}

// The uncovered region = boundary minus the union of all zones. Returns null
// when the boundary is fully covered, or the whole boundary when no zones exist.
function computeGap(
  boundaryGeom: GeoJSON.Geometry,
  zones: Zone[]
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  const boundary = toPolyFeature(boundaryGeom);
  if (!boundary) return null;

  const zoneFeatures = zones
    .map((z) => {
      const g = parseGeometry(z.boundary);
      return g ? toPolyFeature(g) : null;
    })
    .filter((f): f is GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> => !!f);

  if (zoneFeatures.length === 0) return boundary;

  let merged: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  try {
    merged =
      zoneFeatures.length === 1
        ? zoneFeatures[0]
        : union({ type: "FeatureCollection", features: zoneFeatures });
  } catch {
    return boundary;
  }
  if (!merged) return boundary;

  try {
    return difference({
      type: "FeatureCollection",
      features: [boundary, merged],
    });
  } catch {
    return boundary;
  }
}

// Narrow a geometry to a Polygon/MultiPolygon feature (what the turf ops want).
function toPolyFeature(
  geom: GeoJSON.Geometry
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") return null;
  return { type: "Feature", properties: {}, geometry: geom };
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

const primaryBtnStyle: React.CSSProperties = {
  marginTop: 16,
  width: "100%",
  background: "#06D6A0",
  color: "#000",
  border: "none",
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 700,
  fontSize: "0.9rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#aaa",
  border: "1px solid #333",
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 600,
  fontSize: "0.9rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryFullBtnStyle: React.CSSProperties = {
  ...secondaryBtnStyle,
  width: "100%",
  marginTop: 10,
};
