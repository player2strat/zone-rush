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
import { useNavigate } from "react-router-dom";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
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
  borough?: string;
  description?: string;
}

// Source/layer ids we manage on the map.
const SRC_ZONES = "zb-saved-zones";
const SRC_ZONE_LABELS = "zb-zone-labels";
const SRC_BOUNDARY = "zb-map-boundary";
const SRC_GAP = "zb-coverage-gap";

export default function ZoneBuilder() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  const drawTarget = useRef<"zone" | "boundary" | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const fittedMapRef = useRef<string>("");
  // Latest startEditZone, so the once-registered map-click handler isn't stale.
  const startEditZoneRef = useRef<(zoneId: string) => void>(() => {});

  const [cityId, setCityId] = useState("nyc");
  const [maps, setMaps] = useState<MapOption[]>([]);
  const [selectedMapId, setSelectedMapId] = useState("");
  const [zones, setZones] = useState<Zone[]>([]);
  const [loadingMaps, setLoadingMaps] = useState(false);
  const [loadingZones, setLoadingZones] = useState(false);
  const [message, setMessage] = useState("");

  // Pending geometry being worked on — either a freshly drawn zone (editingZoneId
  // null) or an existing zone being reshaped (editingZoneId set). The metadata
  // form and overlap check both read this.
  const [pendingGeometry, setPendingGeometry] = useState<GeoJSON.Geometry | null>(null);
  const pendingDrawId = useRef<string | null>(null);
  // Set when editing an existing saved zone (its doc id). null for a new zone.
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const editDrawId = useRef<string | null>(null); // draw-feature id of the zone under edit
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
  // True from the moment a boundary redraw starts until it's saved or cancelled.
  // While true we hide the previously-saved boundary (and its gap) so you draw
  // the new frame on a clean canvas, not on top of the old one.
  const [redrawingBoundary, setRedrawingBoundary] = useState(false);
  // Which shape is being actively drawn right now (armed, points not yet
  // finished). Drives the "drawing…" active state in the panel.
  const [drawingMode, setDrawingMode] = useState<"zone" | "boundary" | null>(null);
  // Set on draw.create so the follow-up modechange knows the draw completed
  // (vs. was cancelled with Escape).
  const justCreated = useRef(false);

  // Panel mode: work on an existing map, or create a new one. These are
  // alternatives — only one shows at a time so they don't read as one flow.
  const [mode, setMode] = useState<"open" | "create">("open");
  const [newMapName, setNewMapName] = useState("");
  const [newMapBorough, setNewMapBorough] = useState("");
  const [newMapDesc, setNewMapDesc] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Duplicate-map flow.
  const [duplicatingOpen, setDuplicatingOpen] = useState(false);
  const [dupName, setDupName] = useState("");
  const [dupBusy, setDupBusy] = useState(false);

  // Edit-map-details flow (rename / borough / description).
  const [editMapOpen, setEditMapOpen] = useState(false);
  const [emName, setEmName] = useState("");
  const [emBorough, setEmBorough] = useState("");
  const [emDesc, setEmDesc] = useState("");
  const [emBusy, setEmBusy] = useState(false);

  const selectedMap = maps.find((m) => m.id === selectedMapId) || null;

  // Real (non-sliver) overlaps between the pending zone and each saved zone.
  // When editing, exclude the zone itself (it always "overlaps" its own area).
  const overlaps = useMemo(
    () =>
      pendingGeometry
        ? computeOverlaps(
            pendingGeometry,
            zones.filter((z) => z.id !== editingZoneId)
          )
        : [],
    [pendingGeometry, zones, editingZoneId]
  );

  // Coverage gap: the part of the map boundary not yet covered by any zone.
  // Suppressed while redrawing the boundary — the reference frame is hidden then.
  const gapFeature = useMemo(() => {
    if (redrawingBoundary) return null;
    const b = selectedMap?.boundary ? parseGeometry(selectedMap.boundary) : null;
    if (!b) return null;
    return computeGap(b, zones);
  }, [selectedMap?.boundary, zones, redrawingBoundary]);

  // Percent of the boundary still uncovered (null when no boundary / redrawing).
  const gapPercent = useMemo(() => {
    if (redrawingBoundary) return null;
    const b = selectedMap?.boundary ? parseGeometry(selectedMap.boundary) : null;
    const bf = b ? toPolyFeature(b) : null;
    if (!bf) return null;
    const total = area(bf);
    if (total <= 0) return null;
    const gapArea = gapFeature ? area(gapFeature) : 0;
    return Math.max(0, Math.min(100, Math.round((gapArea / total) * 100)));
  }, [selectedMap?.boundary, gapFeature, redrawingBoundary]);

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
            borough: data.borough,
            description: data.description,
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

  // ---- Drop any in-progress drawing when the selected map changes ----
  useEffect(() => {
    draw.current?.deleteAll();
    pendingDrawId.current = null;
    pendingBoundaryDrawId.current = null;
    editDrawId.current = null;
    justCreated.current = false;
    setPendingGeometry(null);
    setEditingZoneId(null);
    setPendingBoundary(null);
    setRedrawingBoundary(false);
    setOverrideOverlap(false);
    setDrawingMode(null);
    setDuplicatingOpen(false);
    setDupName("");
    setEditMapOpen(false);
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
      map.current.on("draw.modechange", handleDrawModeChange as never);
      map.current.on("draw.update", handleDrawUpdate as never);

      // Click a saved zone's shape to edit it (ref keeps the handler current).
      map.current.on("click", `${SRC_ZONES}-fill`, (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) startEditZoneRef.current(String(id));
      });
      map.current.on("mouseenter", `${SRC_ZONES}-fill`, () => {
        if (map.current) map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", `${SRC_ZONES}-fill`, () => {
        if (map.current) map.current.getCanvas().style.cursor = "";
      });

      setMapReady(true);
    });

    return () => {
      map.current?.remove();
      map.current = null;
      draw.current = null;
    };
  }, []);

  // A polygon was finished — route it to the zone form or the boundary confirm,
  // depending on which "draw" button started it. We keep the feature in the draw
  // layer (so the user sees it) until they save or cancel.
  function handleDrawCreate(e: { features: GeoJSON.Feature[] }) {
    const f = e.features?.[0];
    if (!f || !f.geometry) return;
    const target = drawTarget.current;
    drawTarget.current = null;
    justCreated.current = true; // tell the follow-up modechange this completed
    setDrawingMode(null);
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

  // Leaving draw mode back to select — either the polygon finished (handled by
  // draw.create, justCreated=true) or it was cancelled with Escape. On a cancel
  // we disarm and restore any boundary we'd hidden for the redraw.
  function handleDrawModeChange(e: { mode: string }) {
    if (e.mode !== "simple_select") return;
    setDrawingMode(null);
    drawTarget.current = null;
    if (justCreated.current) {
      justCreated.current = false;
    } else {
      setRedrawingBoundary(false);
    }
  }

  // Live geometry while editing an existing zone (vertex drag/add/delete).
  function handleDrawUpdate(e: { features: GeoJSON.Feature[] }) {
    const f = e.features?.[0];
    if (!f || !f.geometry) return;
    if (editDrawId.current && String(f.id) === editDrawId.current) {
      setPendingGeometry(f.geometry);
    }
  }

  // ---- Push zones + boundary onto the map whenever they change ----
  useEffect(() => {
    if (!mapReady || !map.current) return;

    // Zones → polygon features + label points.
    const zoneFeatures: GeoJSON.Feature[] = [];
    const labelFeatures: GeoJSON.Feature[] = [];
    for (const z of zones) {
      // The zone under edit is shown by the draw tool instead — skip it here so
      // it isn't drawn twice.
      if (z.id === editingZoneId) continue;
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

    // Boundary — hidden while redrawing, so the old frame doesn't sit under the
    // new one being drawn.
    const boundaryGeom =
      selectedMap?.boundary && !redrawingBoundary
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
  }, [zones, selectedMap, selectedMapId, mapReady, redrawingBoundary, editingZoneId]);

  // ---- Push the coverage gap onto the map whenever it changes ----
  useEffect(() => {
    if (!mapReady || !map.current) return;
    (map.current.getSource(SRC_GAP) as mapboxgl.GeoJSONSource)?.setData(
      gapFeature ?? emptyFC()
    );
  }, [gapFeature, mapReady]);

  // Keep the map-click handler pointing at the current startEditZone closure.
  useEffect(() => {
    startEditZoneRef.current = startEditZone;
  });

  // ---- Drawing + saving zones ----

  function startDrawZone() {
    if (!selectedMapId) {
      setMessage("Error: pick a map first.");
      return;
    }
    cancelPending();
    cancelPendingBoundary();
    drawTarget.current = "zone";
    justCreated.current = false;
    setDrawingMode("zone");
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
    justCreated.current = false;
    setRedrawingBoundary(true); // hide the old frame while drawing the new one
    setDrawingMode("boundary");
    draw.current?.changeMode("draw_polygon");
    setMessage("Draw the map's outer frame; double-click (or Enter) to finish.");
  }

  // Abort an armed draw before it's finished (explicit Cancel button).
  function cancelDrawing() {
    justCreated.current = false;
    try {
      draw.current?.changeMode("simple_select"); // discards the in-progress shape
    } catch {
      /* not in a draw mode */
    }
    drawTarget.current = null;
    setDrawingMode(null);
    setRedrawingBoundary(false);
    setMessage("");
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
    setRedrawingBoundary(false); // restore the saved frame (cancel) or show new (save)
  }

  // Compute a {lat,lng,zoom} that frames the given features, using the live map
  // so the zoom actually fits. City-agnostic — works anywhere on Earth. Returns
  // null if the map isn't ready or the features have no usable extent.
  function centerFromFeatures(
    features: GeoJSON.Feature[]
  ): { lat: number; lng: number; zoom: number } | null {
    if (!map.current || features.length === 0) return null;
    try {
      const [minX, minY, maxX, maxY] = bbox({
        type: "FeatureCollection",
        features,
      });
      const cam = map.current.cameraForBounds(
        [
          [minX, minY],
          [maxX, maxY],
        ],
        { padding: 40 }
      );
      if (!cam || !cam.center) return null;
      const ctr = cam.center as { lng: number; lat: number };
      return {
        lat: Math.round(ctr.lat * 1e6) / 1e6,
        lng: Math.round(ctr.lng * 1e6) / 1e6,
        zoom: Math.round((cam.zoom ?? 12) * 100) / 100,
      };
    } catch {
      return null;
    }
  }

  async function saveBoundary() {
    if (!pendingBoundary || !selectedMapId) return;
    setSavingBoundary(true);
    try {
      const boundaryStr = JSON.stringify(pendingBoundary);
      // Auto-frame the map on its new boundary (city-agnostic centering).
      const newCenter = centerFromFeatures([
        { type: "Feature", properties: {}, geometry: pendingBoundary },
      ]);
      const update: Record<string, unknown> = { boundary: boundaryStr };
      if (newCenter) update.map_center = newCenter;

      await setDoc(doc(db, "maps", selectedMapId), update, { merge: true });
      // Reflect locally so the boundary + coverage aid update immediately.
      setMaps((prev) =>
        prev.map((m) =>
          m.id === selectedMapId
            ? { ...m, boundary: boundaryStr, ...(newCenter ? { map_center: newCenter } : {}) }
            : m
        )
      );
      cancelPendingBoundary();
      setMessage("Map boundary saved.");
    } catch (err) {
      setMessage("Error saving boundary: " + (err as Error).message);
    }
    setSavingBoundary(false);
  }

  // Import a boundary outline from a GeoJSON file. Loads it as a pending
  // boundary (added to the draw layer + previewed on the map); the existing
  // Save/Cancel confirm then persists or discards it.
  async function importBoundaryFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!selectedMapId) {
      setMessage("Error: pick a map first.");
      return;
    }
    try {
      const geojson = JSON.parse(await file.text());
      const geom = extractBoundaryGeometry(geojson);
      if (!geom) {
        setMessage("Error: no polygon found in that file.");
        return;
      }
      cancelPending();
      cancelPendingBoundary();
      const feature: GeoJSON.Feature = {
        type: "Feature",
        properties: {},
        geometry: geom,
      };
      const ids = draw.current?.add(feature);
      pendingBoundaryDrawId.current = ids && ids.length ? String(ids[0]) : null;
      setRedrawingBoundary(true); // hide any existing boundary while previewing
      setPendingBoundary(geom);
      try {
        const [minX, minY, maxX, maxY] = bbox(feature);
        map.current?.fitBounds(
          [
            [minX, minY],
            [maxX, maxY],
          ],
          { padding: 60, maxZoom: 15, duration: 500 }
        );
      } catch {
        /* ignore */
      }
      setMessage("Imported boundary — review it, then Save boundary or Cancel.");
    } catch (err) {
      setMessage("Error reading file: " + (err as Error).message);
    }
  }

  // ---- New map + publish ----

  async function createMap() {
    const name = newMapName.trim();
    if (!name) {
      setMessage("Error: give the map a name.");
      return;
    }
    setCreatingBusy(true);
    try {
      const id = `map_${slugify(name)}_${Date.now().toString(36)}`;
      const mapDoc: Record<string, unknown> = {
        id,
        name,
        city: cityId,
        is_active: false,
        created_at: serverTimestamp(),
        map_center: defaultCenterFor(cityId),
      };
      if (newMapBorough.trim()) mapDoc.borough = newMapBorough.trim();
      if (newMapDesc.trim()) mapDoc.description = newMapDesc.trim();
      await setDoc(doc(db, "maps", id), mapDoc);

      // Reflect locally and open the new (empty) map.
      setMaps((prev) =>
        [...prev, { id, name, is_active: false, map_center: mapDoc.map_center as MapOption["map_center"] }].sort(
          (a, b) => a.name.localeCompare(b.name)
        )
      );
      setSelectedMapId(id);
      setMode("open");
      setNewMapName("");
      setNewMapBorough("");
      setNewMapDesc("");
      setMessage(`Created map "${name}". Draw its boundary and zones.`);
    } catch (err) {
      setMessage("Error creating map: " + (err as Error).message);
    }
    setCreatingBusy(false);
  }

  async function togglePublish() {
    if (!selectedMap) return;
    const next = !selectedMap.is_active;
    // Publishing with uncovered gaps is allowed, but worth a heads-up.
    if (next && gapPercent !== null && gapPercent > 0) {
      const ok = window.confirm(
        `This map still has ~${gapPercent}% uncovered space. Publish anyway?`
      );
      if (!ok) return;
    }
    setPublishing(true);
    try {
      await setDoc(
        doc(db, "maps", selectedMap.id),
        { is_active: next },
        { merge: true }
      );
      setMaps((prev) =>
        prev.map((m) =>
          m.id === selectedMap.id ? { ...m, is_active: next } : m
        )
      );
      setMessage(next ? "Map published — it's now selectable." : "Map unpublished.");
    } catch (err) {
      setMessage("Error updating publish state: " + (err as Error).message);
    }
    setPublishing(false);
  }

  // Duplicate the selected map into a new unpublished draft: copies the map's
  // metadata + boundary and every zone (as fresh docs pointed at the new map).
  // The original is untouched. One atomic batched write.
  async function duplicateMap() {
    if (!selectedMap) return;
    const name = dupName.trim() || `Copy of ${selectedMap.name}`;
    setDupBusy(true);
    try {
      // Read the source map + its zones fresh, so the copy matches what's saved.
      const [srcMapSnap, zoneSnap] = await Promise.all([
        getDoc(doc(db, "maps", selectedMap.id)),
        getDocs(
          query(collection(db, "zones"), where("map_id", "==", selectedMap.id))
        ),
      ]);
      const srcMapData = srcMapSnap.exists() ? srcMapSnap.data() : {};

      const newMapId = `map_${slugify(name)}_${Date.now().toString(36)}`;
      const batch = writeBatch(db);

      // Spread the source map so optional metadata (boundary, map_center,
      // borough, description, …) carries over, then override the identity fields.
      batch.set(doc(db, "maps", newMapId), {
        ...srcMapData,
        id: newMapId,
        name,
        is_active: false, // always a draft — never auto-selectable at game creation
        created_at: serverTimestamp(),
      });

      zoneSnap.docs.forEach((d, i) => {
        const z = d.data() as Zone;
        const newZoneId = `zone_${newMapId}_${Date.now().toString(36)}${i}`;
        batch.set(doc(db, "zones", newZoneId), {
          ...z,
          id: newZoneId,
          map_id: newMapId,
        });
      });

      await batch.commit();

      // Reflect locally and open the copy.
      setMaps((prev) =>
        [
          ...prev,
          {
            id: newMapId,
            name,
            is_active: false,
            boundary: selectedMap.boundary,
            map_center: selectedMap.map_center,
          },
        ].sort((a, b) => a.name.localeCompare(b.name))
      );
      setSelectedMapId(newMapId);
      setDuplicatingOpen(false);
      setDupName("");
      setMessage(
        `Duplicated "${selectedMap.name}" → "${name}" (${zoneSnap.size} zones). Opened the copy.`
      );
    } catch (err) {
      setMessage("Error duplicating map: " + (err as Error).message);
    }
    setDupBusy(false);
  }

  function openEditMap() {
    if (!selectedMap) return;
    setEmName(selectedMap.name || "");
    setEmBorough(selectedMap.borough || "");
    setEmDesc(selectedMap.description || "");
    setEditMapOpen(true);
  }

  // Save edits to the map's own details (name / borough / description).
  async function saveMapDetails() {
    if (!selectedMap) return;
    const name = emName.trim();
    if (!name) {
      setMessage("Error: the map needs a name.");
      return;
    }
    setEmBusy(true);
    try {
      const update = {
        name,
        borough: emBorough.trim(),
        description: emDesc.trim(),
      };
      await setDoc(doc(db, "maps", selectedMap.id), update, { merge: true });
      setMaps((prev) =>
        prev
          .map((m) => (m.id === selectedMap.id ? { ...m, ...update } : m))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setEditMapOpen(false);
      setMessage(`Saved map details for "${name}".`);
    } catch (err) {
      setMessage("Error saving map details: " + (err as Error).message);
    }
    setEmBusy(false);
  }

  // Remove the pending drawn/edited feature and reset the form. Covers both a
  // new zone in progress and an existing zone being edited.
  function cancelPending() {
    if (pendingDrawId.current) {
      try {
        draw.current?.delete(pendingDrawId.current);
      } catch {
        /* already gone */
      }
    }
    if (editDrawId.current) {
      try {
        draw.current?.delete(editDrawId.current);
      } catch {
        /* already gone */
      }
    }
    // If we were in an edit (direct_select) mode, return to plain select so the
    // static zone layer takes over rendering again.
    if (editDrawId.current) {
      try {
        draw.current?.changeMode("simple_select");
      } catch {
        /* not in a draw mode */
      }
    }
    pendingDrawId.current = null;
    editDrawId.current = null;
    setEditingZoneId(null);
    setPendingGeometry(null);
    setZoneName("");
    setCultureTags("");
    setLandmarks("");
    setTransit("");
    setDifficulty(3);
    setOverrideOverlap(false);
  }

  // Load a saved zone into the draw tool for reshaping, and open its metadata in
  // the form. Ignored while busy with another draw/edit so you don't lose work.
  function startEditZone(zoneId: string) {
    if (drawingMode || pendingBoundary || pendingGeometry) return;
    const z = zones.find((zz) => zz.id === zoneId);
    if (!z) return;
    const geom = parseGeometry(z.boundary);
    if (!geom) {
      setMessage("Error: this zone has no editable polygon.");
      return;
    }
    const feature: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: geom,
    };
    const ids = draw.current?.add(feature);
    const drawId = ids && ids.length ? String(ids[0]) : null;
    editDrawId.current = drawId;
    if (drawId) {
      try {
        draw.current?.changeMode("direct_select", { featureId: drawId });
      } catch {
        try {
          draw.current?.changeMode("simple_select", { featureIds: [drawId] });
        } catch {
          /* leave in default mode */
        }
      }
    }
    setEditingZoneId(zoneId);
    setPendingGeometry(geom);
    setZoneName(z.name || "");
    setCultureTags((z.culture_tags || []).join(", "));
    setLandmarks((z.landmarks || []).join(", "));
    setTransit((z.transit_lines || []).join(", "));
    setDifficulty(z.difficulty_rating || 3);
    setOverrideOverlap(false);
    // Fly to the zone so its vertices are easy to grab.
    try {
      const [minX, minY, maxX, maxY] = bbox(feature);
      map.current?.fitBounds(
        [
          [minX, minY],
          [maxX, maxY],
        ],
        { padding: 80, maxZoom: 15, duration: 500 }
      );
    } catch {
      /* ignore */
    }
    setMessage("Editing zone — drag the points to reshape, then Save changes.");
  }

  // Delete a saved zone from Firestore and the map.
  async function deleteZone(zoneId: string) {
    const z = zones.find((zz) => zz.id === zoneId);
    if (!window.confirm(`Delete "${z?.name || "this zone"}"? This can't be undone.`))
      return;
    setSaving(true);
    try {
      await deleteDoc(doc(db, "zones", zoneId));
      if (editingZoneId === zoneId) cancelPending();
      setZones((prev) => prev.filter((zz) => zz.id !== zoneId));
      setMessage(`Deleted "${z?.name || "zone"}".`);
    } catch (err) {
      setMessage("Error deleting zone: " + (err as Error).message);
    }
    setSaving(false);
  }

  // Save the pending zone. When `carve` is true, overlapping neighbors are
  // trimmed so this zone wins the contested area (clean shared borders); when
  // false, overlap is blocked unless the user overrode it.
  async function saveZone(carve = false) {
    if (!pendingGeometry || !selectedMapId) return;
    if (overlaps.length > 0 && !overrideOverlap && !carve) {
      setMessage(
        "Error: this zone overlaps an existing one. Fix it, check 'save anyway', or Fit neighbors."
      );
      return;
    }
    setSaving(true);
    try {
      // Prefer the freshest geometry from the draw tool (edit vertex drags).
      let geom = pendingGeometry;
      if (editingZoneId && editDrawId.current) {
        const f = draw.current?.get(editDrawId.current);
        if (f?.geometry) geom = f.geometry as GeoJSON.Geometry;
      }
      const c = center({ type: "Feature", properties: {}, geometry: geom });
      const [lng, lat] = c.geometry.coordinates;
      const name = zoneName.trim() || "Untitled zone";
      const fields = {
        name,
        boundary: JSON.stringify(geom),
        center_lat: Math.round(lat * 1e6) / 1e6,
        center_lng: Math.round(lng * 1e6) / 1e6,
        culture_tags: splitTags(cultureTags),
        transit_lines: splitTags(transit),
        landmarks: splitTags(landmarks),
        difficulty_rating: difficulty,
      };

      // If carving, compute the trimmed shape of each overlapping neighbor
      // (neighbor − thisZone). Abort if any neighbor would be fully consumed.
      const clipped: {
        id: string;
        boundary: string;
        center_lat: number;
        center_lng: number;
      }[] = [];
      if (carve) {
        const aFeature = toPolyFeature(geom);
        const vanished: string[] = [];
        for (const o of overlaps) {
          const z = zones.find((zz) => zz.id === o.id);
          const zg = z ? parseGeometry(z.boundary) : null;
          const zf = zg ? toPolyFeature(zg) : null;
          if (!zf || !aFeature) continue;
          let diff: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
          try {
            diff = difference({
              type: "FeatureCollection",
              features: [zf, aFeature],
            });
          } catch {
            diff = zf; // can't clip this one — leave it unchanged
          }
          if (!diff) {
            vanished.push(z?.name || o.id);
            continue;
          }
          const cc = center(diff);
          clipped.push({
            id: o.id,
            boundary: JSON.stringify(diff.geometry),
            center_lat: Math.round(cc.geometry.coordinates[1] * 1e6) / 1e6,
            center_lng: Math.round(cc.geometry.coordinates[0] * 1e6) / 1e6,
          });
        }
        if (vanished.length) {
          setMessage(
            `Can't fit: ${vanished.join(
              ", "
            )} would be fully covered. Shrink this zone or delete them first.`
          );
          setSaving(false);
          return;
        }
      }

      // One atomic write: this zone (create or update) + any clipped neighbors.
      const batch = writeBatch(db);
      const newId =
        editingZoneId ||
        `zone_${selectedMapId}_${Date.now().toString(36)}${Math.floor(
          Math.random() * 1000
        )}`;
      if (editingZoneId) {
        batch.set(doc(db, "zones", editingZoneId), fields, { merge: true });
      } else {
        batch.set(doc(db, "zones", newId), {
          id: newId,
          map_id: selectedMapId,
          city: cityId,
          ...fields,
        });
      }
      for (const cl of clipped) {
        batch.set(
          doc(db, "zones", cl.id),
          {
            boundary: cl.boundary,
            center_lat: cl.center_lat,
            center_lng: cl.center_lng,
          },
          { merge: true }
        );
      }

      // With no boundary to frame the map, keep its center on the zones so it's
      // correctly located for any city (not left at a stale default).
      let zoneCenter: { lat: number; lng: number; zoom: number } | null = null;
      if (!selectedMap?.boundary) {
        const feats: GeoJSON.Feature[] = [];
        for (const z of zones) {
          if (z.id === editingZoneId) continue;
          const g = parseGeometry(z.boundary);
          if (g) feats.push({ type: "Feature", properties: {}, geometry: g });
        }
        feats.push({ type: "Feature", properties: {}, geometry: geom });
        zoneCenter = centerFromFeatures(feats);
        if (zoneCenter) {
          batch.set(
            doc(db, "maps", selectedMapId),
            { map_center: zoneCenter },
            { merge: true }
          );
        }
      }

      await batch.commit();

      if (zoneCenter) {
        setMaps((prev) =>
          prev.map((m) =>
            m.id === selectedMapId ? { ...m, map_center: zoneCenter! } : m
          )
        );
      }

      // Reflect locally: update edited/clipped zones, append a new one.
      setZones((prev) => {
        const clippedById = new Map(clipped.map((cl) => [cl.id, cl]));
        let next = prev.map((z) => {
          if (z.id === editingZoneId) return { ...z, ...fields };
          const cl = clippedById.get(z.id);
          return cl
            ? {
                ...z,
                boundary: cl.boundary,
                center_lat: cl.center_lat,
                center_lng: cl.center_lng,
              }
            : z;
        });
        if (!editingZoneId) {
          next = [
            ...next,
            { id: newId, map_id: selectedMapId, city: cityId, ...fields },
          ];
        }
        return next;
      });

      cancelPending();
      setMessage(
        clipped.length
          ? `Saved "${name}" and trimmed ${clipped.length} neighbor${
              clipped.length > 1 ? "s" : ""
            }.`
          : editingZoneId
          ? `Saved changes to "${name}".`
          : `Saved zone "${name}".`
      );
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
        <p style={{ color: "#888", fontSize: "0.82rem", marginBottom: 12 }}>
          Open a map to draw its boundary and zones, or create a new one.
        </p>
        <button
          onClick={() => navigate("/admin/zones")}
          style={crossLinkStyle}
        >
          Bulk-import zones in Zone Manager →
        </button>

        <label style={{ ...labelStyle, marginTop: 20 }}>City</label>
        <input
          value={cityId}
          onChange={(e) => setCityId(e.target.value.toLowerCase())}
          style={inputStyle}
        />

        {/* Mode toggle: open existing vs. create new (alternatives) */}
        <div
          style={{
            display: "flex",
            gap: 6,
            marginTop: 18,
            padding: 4,
            background: "#111",
            border: "1px solid #222",
            borderRadius: 10,
          }}
        >
          <button onClick={() => setMode("open")} style={segBtnStyle(mode === "open")}>
            Open existing
          </button>
          <button
            onClick={() => setMode("create")}
            style={segBtnStyle(mode === "create")}
          >
            Create new
          </button>
        </div>

        {/* Create new map */}
        {mode === "create" && (
          <div style={{ marginTop: 16 }}>
            <label style={labelStyle}>Name</label>
            <input
              value={newMapName}
              onChange={(e) => setNewMapName(e.target.value)}
              placeholder="e.g. Brooklyn Alpha"
              style={inputStyle}
              autoFocus
            />
            <label style={{ ...labelStyle, marginTop: 12 }}>
              Borough (optional)
            </label>
            <input
              value={newMapBorough}
              onChange={(e) => setNewMapBorough(e.target.value)}
              placeholder="Brooklyn"
              style={inputStyle}
            />
            <label style={{ ...labelStyle, marginTop: 12 }}>
              Description (optional)
            </label>
            <input
              value={newMapDesc}
              onChange={(e) => setNewMapDesc(e.target.value)}
              placeholder="Short blurb for the map picker"
              style={inputStyle}
            />
            <button
              onClick={createMap}
              disabled={creatingBusy}
              style={{
                ...primaryBtnStyle,
                opacity: creatingBusy ? 0.6 : 1,
                cursor: creatingBusy ? "not-allowed" : "pointer",
              }}
            >
              {creatingBusy ? "Creating…" : "Create map"}
            </button>
            <p style={{ color: "#555", fontSize: "0.75rem", marginTop: 10 }}>
              Creates a draft map, then opens it so you can draw its boundary and
              zones.
            </p>
          </div>
        )}

        {/* Open existing map */}
        {mode === "open" && (
          <>
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

            {!selectedMap && maps.length > 0 && (
              <p style={{ color: "#555", fontSize: "0.75rem", marginTop: 10 }}>
                Pick a map to edit its zones and boundary.
              </p>
            )}

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
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid #1a1a1a",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  color: selectedMap.is_active ? "#06D6A0" : "#888",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                }}
              >
                {selectedMap.is_active ? "● Published" : "○ Draft"}
              </span>
              <button
                onClick={togglePublish}
                disabled={publishing}
                style={{
                  background: selectedMap.is_active
                    ? "transparent"
                    : "#06D6A0",
                  color: selectedMap.is_active ? "#aaa" : "#000",
                  border: selectedMap.is_active
                    ? "1px solid #333"
                    : "none",
                  borderRadius: 7,
                  padding: "7px 14px",
                  fontWeight: 700,
                  fontSize: "0.82rem",
                  cursor: publishing ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  opacity: publishing ? 0.6 : 1,
                }}
              >
                {publishing
                  ? "…"
                  : selectedMap.is_active
                  ? "Unpublish"
                  : "Publish map"}
              </button>
            </div>
          </div>
        )}

        {/* Edit map details */}
        {selectedMap &&
          !drawingMode &&
          !pendingGeometry &&
          !pendingBoundary &&
          (editMapOpen ? (
            <div
              style={{
                marginTop: 16,
                padding: 14,
                background: "rgba(255,255,255,0.02)",
                border: "1px solid #1a1a1a",
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 10 }}>
                Edit map details
              </div>
              <label style={labelStyle}>Name</label>
              <input
                value={emName}
                onChange={(e) => setEmName(e.target.value)}
                style={inputStyle}
                autoFocus
              />
              <label style={{ ...labelStyle, marginTop: 12 }}>
                Borough (optional)
              </label>
              <input
                value={emBorough}
                onChange={(e) => setEmBorough(e.target.value)}
                placeholder="Brooklyn"
                style={inputStyle}
              />
              <label style={{ ...labelStyle, marginTop: 12 }}>
                Description (optional)
              </label>
              <input
                value={emDesc}
                onChange={(e) => setEmDesc(e.target.value)}
                placeholder="Short blurb for the map picker"
                style={inputStyle}
              />
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  onClick={saveMapDetails}
                  disabled={emBusy}
                  style={{
                    ...primaryBtnStyle,
                    marginTop: 0,
                    flex: 1,
                    opacity: emBusy ? 0.6 : 1,
                    cursor: emBusy ? "not-allowed" : "pointer",
                  }}
                >
                  {emBusy ? "Saving…" : "Save details"}
                </button>
                <button
                  onClick={() => setEditMapOpen(false)}
                  disabled={emBusy}
                  style={secondaryBtnStyle}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={openEditMap} style={secondaryFullBtnStyle}>
              ✎ Edit map details
            </button>
          ))}

        {/* Duplicate map */}
        {selectedMap &&
          !drawingMode &&
          !pendingGeometry &&
          !pendingBoundary &&
          (duplicatingOpen ? (
            <div
              style={{
                marginTop: 16,
                padding: 14,
                background: "rgba(255,255,255,0.02)",
                border: "1px solid #1a1a1a",
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 10 }}>
                Duplicate map
              </div>
              <label style={labelStyle}>New map name</label>
              <input
                value={dupName}
                onChange={(e) => setDupName(e.target.value)}
                style={inputStyle}
                autoFocus
              />
              <p style={{ color: "#555", fontSize: "0.75rem", marginTop: 8 }}>
                Copies {zones.length} zone{zones.length === 1 ? "" : "s"}
                {selectedMap.boundary ? " + boundary" : ""} into a new draft.
                The original stays unchanged.
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  onClick={duplicateMap}
                  disabled={dupBusy}
                  style={{
                    ...primaryBtnStyle,
                    marginTop: 0,
                    flex: 1,
                    opacity: dupBusy ? 0.6 : 1,
                    cursor: dupBusy ? "not-allowed" : "pointer",
                  }}
                >
                  {dupBusy ? "Duplicating…" : "Duplicate"}
                </button>
                <button
                  onClick={() => {
                    setDuplicatingOpen(false);
                    setDupName("");
                  }}
                  disabled={dupBusy}
                  style={secondaryBtnStyle}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setDupName(`Copy of ${selectedMap.name}`);
                setDuplicatingOpen(true);
              }}
              style={secondaryFullBtnStyle}
            >
              ⧉ Duplicate map
            </button>
          ))}

        {/* Drawing in progress — active state so it's clear the tool is armed */}
        {selectedMap && drawingMode && (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              background:
                drawingMode === "boundary"
                  ? "rgba(255,209,102,0.1)"
                  : "rgba(6,214,160,0.1)",
              border: `1px solid ${
                drawingMode === "boundary"
                  ? "rgba(255,209,102,0.5)"
                  : "rgba(6,214,160,0.5)"
              }`,
              borderRadius: 10,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              ✎ Drawing {drawingMode === "boundary" ? "map boundary" : "zone"}…
            </div>
            <div
              style={{ color: "#999", fontSize: "0.8rem", marginBottom: 12 }}
            >
              Click points on the map; double-click (or Enter) to finish, or Esc
              to cancel.
            </div>
            <button
              onClick={cancelDrawing}
              style={{ ...secondaryFullBtnStyle, marginTop: 0 }}
            >
              Cancel drawing
            </button>
          </div>
        )}

        {/* Draw actions */}
        {selectedMap && !drawingMode && !pendingGeometry && !pendingBoundary && (
          <>
            <button onClick={startDrawZone} style={primaryBtnStyle}>
              ✏️ Draw a zone
            </button>
            <button onClick={startDrawBoundary} style={secondaryFullBtnStyle}>
              {selectedMap.boundary
                ? "↺ Redraw map boundary"
                : "＋ Draw map boundary"}
            </button>
            <label
              style={{
                ...secondaryFullBtnStyle,
                display: "block",
                textAlign: "center",
              }}
            >
              ⬆ Import boundary (GeoJSON)
              <input
                type="file"
                accept=".geojson,.json"
                onChange={importBoundaryFile}
                style={{ display: "none" }}
              />
            </label>
          </>
        )}

        {/* Zones list — pick one to edit or delete */}
        {selectedMap &&
          !drawingMode &&
          !pendingGeometry &&
          !pendingBoundary &&
          zones.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <p style={{ ...labelStyle, marginBottom: 8 }}>
                Zones ({zones.length}) — click to edit
              </p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  maxHeight: 260,
                  overflowY: "auto",
                }}
              >
                {[...zones]
                  .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                  .map((z) => (
                    <div
                      key={z.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid #1a1a1a",
                        borderRadius: 8,
                        padding: "8px 10px",
                      }}
                    >
                      <button
                        onClick={() => startEditZone(z.id)}
                        title="Edit this zone"
                        style={{
                          flex: 1,
                          textAlign: "left",
                          background: "none",
                          border: "none",
                          color: "#ddd",
                          fontSize: "0.85rem",
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {z.name || "Untitled zone"}
                      </button>
                      <button
                        onClick={() => deleteZone(z.id)}
                        title="Delete this zone"
                        style={{
                          background: "none",
                          border: "none",
                          color: "#7a3a48",
                          cursor: "pointer",
                          fontSize: "0.9rem",
                          fontFamily: "inherit",
                          padding: "0 4px",
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
              </div>
            </div>
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
              style={{ fontWeight: 700, marginBottom: 4, fontSize: "0.95rem" }}
            >
              {editingZoneId ? "Edit zone" : "New zone"}
            </div>
            {editingZoneId && (
              <div
                style={{ color: "#8fb7e6", fontSize: "0.78rem", marginBottom: 12 }}
              >
                Drag the points on the map to reshape.
              </div>
            )}

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

                <button
                  onClick={() => saveZone(true)}
                  disabled={saving}
                  title="This zone keeps the contested area; the listed neighbors are trimmed to a clean border."
                  style={{
                    marginTop: 12,
                    width: "100%",
                    background: "#06D6A0",
                    color: "#000",
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 16px",
                    fontWeight: 700,
                    fontSize: "0.85rem",
                    cursor: saving ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  ✂ Fit neighbors &amp; save
                </button>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              {(() => {
                const blocked = overlaps.length > 0 && !overrideOverlap;
                const disabled = saving || blocked;
                return (
                  <button
                    onClick={() => saveZone(false)}
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
                    {saving
                      ? "Saving…"
                      : blocked
                      ? "Overlap — blocked"
                      : editingZoneId
                      ? "Save changes"
                      : "Save zone"}
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

            {editingZoneId && (
              <button
                onClick={() => deleteZone(editingZoneId)}
                disabled={saving}
                style={{
                  marginTop: 10,
                  width: "100%",
                  background: "rgba(239,71,111,0.1)",
                  color: "#EF476F",
                  border: "1px solid rgba(239,71,111,0.3)",
                  borderRadius: 8,
                  padding: "9px 16px",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                Delete zone
              </button>
            )}
          </div>
        )}
          </>
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

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "map"
  );
}

// Rough default center so a brand-new map is selectable/centered before its
// boundary is drawn. NYC-only today; extend when more cities exist.
function defaultCenterFor(cityId: string): {
  lat: number;
  lng: number;
  zoom: number;
} {
  if (cityId === "nyc") return { lat: 40.7128, lng: -74.006, zoom: 12 };
  return { lat: 40.7128, lng: -74.006, zoom: 11 };
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

// Pull a single boundary outline from an uploaded GeoJSON. Accepts a bare
// geometry, a Feature, or a FeatureCollection. If the file has multiple polygon
// features they're unioned into one outline (so a file of a borough's districts
// yields the borough shape). The result is previewed before saving, so an
// over-broad file is easy to catch and cancel.
function extractBoundaryGeometry(
  geojson: unknown
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  const geoms: GeoJSON.Geometry[] = [];
  const g = geojson as {
    type?: string;
    features?: { geometry?: GeoJSON.Geometry }[];
    geometry?: GeoJSON.Geometry;
  };
  if (g?.type === "FeatureCollection" && Array.isArray(g.features)) {
    for (const f of g.features) if (f?.geometry) geoms.push(f.geometry);
  } else if (g?.type === "Feature" && g.geometry) {
    geoms.push(g.geometry);
  } else if (g?.type === "Polygon" || g?.type === "MultiPolygon") {
    geoms.push(g as GeoJSON.Geometry);
  }

  const polys = geoms.filter(
    (x): x is GeoJSON.Polygon | GeoJSON.MultiPolygon =>
      x.type === "Polygon" || x.type === "MultiPolygon"
  );
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];

  try {
    const merged = union({
      type: "FeatureCollection",
      features: polys.map((geom) => ({
        type: "Feature" as const,
        properties: {},
        geometry: geom,
      })),
    });
    return merged ? merged.geometry : polys[0];
  } catch {
    return polys[0];
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

// Subtle inline text link between admin pages.
const crossLinkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#4C9AFF",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "0.8rem",
  fontWeight: 600,
  padding: 0,
  textAlign: "left",
};

// Segmented-control button (Open existing / Create new). Active tab is filled.
function segBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    background: active ? "#222" : "transparent",
    color: active ? "#fff" : "#888",
    border: "none",
    borderRadius: 7,
    padding: "8px 12px",
    fontWeight: 700,
    fontSize: "0.82rem",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
