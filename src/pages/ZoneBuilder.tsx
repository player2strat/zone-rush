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
import union from "@turf/union";
import difference from "@turf/difference";
import area from "@turf/area";
import { db } from "../lib/firebase";
import type { Zone } from "../types/game";
import {
  computeOverlaps,
  computeGap,
  splitPolygonByLine,
  touches,
  toPolyFeature,
  parseGeometry,
  extractBoundaryGeometry,
} from "../lib/zoneGeometry";
import {
  SRC_SNAP,
  BUILTIN_MODES,
  buildSnapTargets,
  createSnapPolygonMode,
  createSnapDirectSelectMode,
  type SnapTarget,
} from "../lib/zoneSnapping";
import { parseZonesFromGeojson } from "../lib/zoneImport";
import { BRAND } from '../lib/brand'

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
const SRC_GAP_SELECTED = "zb-coverage-gap-selected";
const SRC_TOOL_HL = "zb-tool-highlight";
const SRC_SPLIT_PREVIEW = "zb-split-preview";
export default function ZoneBuilder() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  const drawTarget = useRef<"zone" | "boundary" | "split" | null>(null);
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
  // Delete-map confirmation: null = not asked; otherwise the zone count we
  // looked up when the admin first clicked Delete, shown in the confirm box.
  const [deleteConfirm, setDeleteConfirm] = useState<{
    zoneCount: number;
    liveGames: number;   // games in lobby/strategy/active/paused — block delete
    endedGames: number;  // finished games — allow, but warn
  } | null>(null);
  // Fill-gap flow: a clicked uncovered sliver, the zones that touch it, and
  // which one the admin picked to absorb it.
  const [fillGap, setFillGap] = useState<{
    piece: GeoJSON.Feature<GeoJSON.Polygon>;
    candidates: { id: string; name: string }[];
    targetId: string;
  } | null>(null);
  const [fillBusy, setFillBusy] = useState(false);
  // Latest gap pieces + zones, readable from the once-registered click handler.
  const gapPiecesRef = useRef<GeoJSON.Feature<GeoJSON.Polygon>[]>([]);
  const zonesRef = useRef<Zone[]>([]);
  const fillGapBlockedRef = useRef(false);
  // Merge / split tools. While a tool is active, clicking a zone selects it
  // instead of opening it for editing.
  const [tool, setTool] = useState<"merge" | "split" | null>(null);
  const toolRef = useRef<"merge" | "split" | null>(null);
  const toolClickRef = useRef<(zoneId: string) => void>(() => {});
  const splitLineRef = useRef<(geom: GeoJSON.Geometry) => void>(() => {});
  const [toolBusy, setToolBusy] = useState(false);
  // Merge: [keep, absorb] zone ids (0–2 picked so far) + the name to keep.
  const [mergeSel, setMergeSel] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState("");
  // Split: the zone being cut, the phase, the drawn line, and the two pieces.
  const [splitZoneId, setSplitZoneId] = useState<string | null>(null);
  const [splitPhase, setSplitPhase] = useState<"pick" | "line" | "preview">("pick");
  const splitDrawId = useRef<string | null>(null);
  const [splitPieces, setSplitPieces] = useState<{
    a: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    b: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  } | null>(null);
  const [splitNameA, setSplitNameA] = useState("");
  const [splitNameB, setSplitNameB] = useState("");
  // Zone whose delete is awaiting explicit confirmation (list row or edit panel).
  const [confirmZoneDeleteId, setConfirmZoneDeleteId] = useState<string | null>(null);
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
  // True while we're cancelling an armed draw. mapbox-gl-draw fires draw.create
  // from inside changeMode('simple_select') if enough points were placed, so
  // handleDrawCreate must discard that feature instead of treating it as done.
  const cancelling = useRef(false);

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

  // The gap split into individual polygons so each sliver is clickable on its
  // own. Each carries an index so the click handler can find it again.
  const gapPieces = useMemo<GeoJSON.Feature<GeoJSON.Polygon>[]>(() => {
    if (!gapFeature) return [];
    const polys: GeoJSON.Polygon[] =
      gapFeature.geometry.type === "Polygon"
        ? [gapFeature.geometry]
        : gapFeature.geometry.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
    return polys.map((geometry, idx) => ({
      type: "Feature",
      properties: { idx },
      geometry,
    }));
  }, [gapFeature]);
  useEffect(() => {
    gapPiecesRef.current = gapPieces;
    // A recomputed gap invalidates any sliver that was selected before.
    setFillGap(null);
  }, [gapPieces]);
  useEffect(() => {
    zonesRef.current = zones;
  }, [zones]);
  // Don't start a fill while something else is being drawn/edited/confirmed.
  useEffect(() => {
    fillGapBlockedRef.current =
      !!pendingGeometry || !!pendingBoundary || drawingMode !== null || redrawingBoundary || tool !== null;
  }, [pendingGeometry, pendingBoundary, drawingMode, redrawingBoundary, tool]);

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
    // The previous city's map is no longer valid here.
    setSelectedMapId("");
    setZones([]);
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
    setDeleteConfirm(null);
    setConfirmZoneDeleteId(null);
    setFillGap(null);
    // Merge/split state must not leak across maps.
    splitDrawId.current = null;
    if (drawTarget.current === "split") drawTarget.current = null;
    setTool(null);
    setMergeSel([]);
    setMergeName("");
    setSplitZoneId(null);
    setSplitPhase("pick");
    setSplitPieces(null);
    setSplitNameA("");
    setSplitNameB("");
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
        paint: { "fill-color": BRAND.marigold, "fill-opacity": 0.04 },
      });
      map.current.addLayer({
        id: `${SRC_BOUNDARY}-line`,
        type: "line",
        source: SRC_BOUNDARY,
        paint: {
          "line-color": BRAND.marigold,
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
        paint: { "fill-color": BRAND.blue, "fill-opacity": 0.18 },
      });
      map.current.addLayer({
        id: `${SRC_ZONES}-line`,
        type: "line",
        source: SRC_ZONES,
        paint: { "line-color": BRAND.blue, "line-width": 1.5 },
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
      // Zones picked by the merge/split tools.
      map.current.addSource(SRC_TOOL_HL, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_TOOL_HL}-fill`,
        type: "fill",
        source: SRC_TOOL_HL,
        paint: { "fill-color": BRAND.pink, "fill-opacity": 0.35 },
      });
      map.current.addLayer({
        id: `${SRC_TOOL_HL}-line`,
        type: "line",
        source: SRC_TOOL_HL,
        paint: { "line-color": BRAND.pink, "line-width": 2.5 },
      });
      // Split preview — the two halves in contrasting colors.
      map.current.addSource(SRC_SPLIT_PREVIEW, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_SPLIT_PREVIEW}-fill`,
        type: "fill",
        source: SRC_SPLIT_PREVIEW,
        paint: {
          "fill-color": ["match", ["get", "side"], "a", BRAND.green, BRAND.marigold],
          "fill-opacity": 0.4,
        },
      });
      map.current.addLayer({
        id: `${SRC_SPLIT_PREVIEW}-line`,
        type: "line",
        source: SRC_SPLIT_PREVIEW,
        paint: { "line-color": BRAND.ink, "line-width": 2 },
      });
      // The sliver picked for filling — solid highlight over the gap layer.
      map.current.addSource(SRC_GAP_SELECTED, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_GAP_SELECTED}-fill`,
        type: "fill",
        source: SRC_GAP_SELECTED,
        paint: { "fill-color": BRAND.marigold, "fill-opacity": 0.45 },
      });
      map.current.addLayer({
        id: `${SRC_GAP_SELECTED}-line`,
        type: "line",
        source: SRC_GAP_SELECTED,
        paint: { "line-color": BRAND.marigold, "line-width": 2 },
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
          "text-size": 14,
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-max-width": 8,
          "text-line-height": 1.15,
        },
        paint: {
          // Dark map style: white text with a dark halo reads far better than
          // the pale-blue-on-cream combination we had before.
          "text-color": "#ffffff",
          "text-halo-color": "rgba(10, 18, 30, 0.9)",
          "text-halo-width": 2,
          "text-halo-blur": 0.5,
        },
      });

      // Snap indicator — a dot showing where the next drawn point will land.
      map.current.addSource(SRC_SNAP, { type: "geojson", data: emptyFC() });
      map.current.addLayer({
        id: `${SRC_SNAP}-dot`,
        type: "circle",
        source: SRC_SNAP,
        paint: {
          "circle-radius": 6,
          "circle-color": "#FF2D95",
          "circle-stroke-color": BRAND.ink,
          "circle-stroke-width": 2,
        },
      });

      // Polygon drawing. We drive modes from our own buttons, so hide the
      // default control UI. A finished polygon fires 'draw.create'. The custom
      // 'snap_polygon' mode snaps points to existing zones/boundary while drawing.
      draw.current = new MapboxDraw({
        displayControlsDefault: false,
        modes: {
          ...BUILTIN_MODES,
          snap_polygon: createSnapPolygonMode(),
          snap_direct_select: createSnapDirectSelectMode(),
        },
      });
      map.current.addControl(draw.current as unknown as mapboxgl.IControl);
      map.current.on("draw.create", handleDrawCreate as never);
      map.current.on("draw.modechange", handleDrawModeChange as never);
      map.current.on("draw.update", handleDrawUpdate as never);

      // Click a saved zone's shape to edit it (ref keeps the handler current).
      map.current.on("click", `${SRC_ZONES}-fill`, (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (!id) return;
        if (toolRef.current) toolClickRef.current(String(id));
        else startEditZoneRef.current(String(id));
      });
      map.current.on("mouseenter", `${SRC_ZONES}-fill`, () => {
        if (map.current) map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", `${SRC_ZONES}-fill`, () => {
        if (map.current) map.current.getCanvas().style.cursor = "";
      });

      // Click an uncovered sliver to assign it to a neighboring zone.
      map.current.on("click", `${SRC_GAP}-fill`, (e) => {
        if (fillGapBlockedRef.current) return;
        const idx = e.features?.[0]?.properties?.idx;
        const piece = gapPiecesRef.current[Number(idx)];
        if (!piece) return;
        const candidates = zonesRef.current
          .filter((z) => {
            const g = parseGeometry(z.boundary);
            return g ? touches(g, piece.geometry) : false;
          })
          .map((z) => ({ id: z.id, name: z.name }));
        setFillGap({ piece, candidates, targetId: candidates[0]?.id ?? "" });
        setMessage("");
      });
      map.current.on("mouseenter", `${SRC_GAP}-fill`, () => {
        if (map.current && !fillGapBlockedRef.current)
          map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", `${SRC_GAP}-fill`, () => {
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
    if (cancelling.current) {
      // A cancel forced this create — throw the shape away.
      if (f.id != null) {
        try {
          draw.current?.delete(String(f.id));
        } catch {
          /* gone */
        }
      }
      return;
    }
    // Only polygons are zones/boundaries; anything else here is a stray.
    if (drawTarget.current !== "split" && f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") {
      if (f.id != null) {
        try {
          draw.current?.delete(String(f.id));
        } catch {
          /* gone */
        }
      }
      return;
    }
    const target = drawTarget.current;
    drawTarget.current = null;
    justCreated.current = true; // tell the follow-up modechange this completed
    setDrawingMode(null);
    if (target === "split") {
      splitDrawId.current = f.id != null ? String(f.id) : null;
      splitLineRef.current(f.geometry);
      return;
    }
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
    const wasSplit = drawTarget.current === "split";
    setDrawingMode(null);
    drawTarget.current = null;
    if (justCreated.current) {
      justCreated.current = false;
    } else {
      setRedrawingBoundary(false);
      if (wasSplit) {
        setSplitPhase("pick");
        setMessage("Split cancelled. Click a zone to try again.");
      }
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
    (map.current.getSource(SRC_GAP) as mapboxgl.GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: gapPieces,
    });
  }, [gapPieces, mapReady]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    (map.current.getSource(SRC_GAP_SELECTED) as mapboxgl.GeoJSONSource)?.setData(
      fillGap ? { type: "FeatureCollection", features: [fillGap.piece] } : emptyFC()
    );
  }, [fillGap, mapReady]);

  useEffect(() => {
    if (!mapReady || !map.current) return;
    const ids = tool === "merge" ? mergeSel : splitZoneId ? [splitZoneId] : [];
    const feats: GeoJSON.Feature[] = [];
    for (const id of ids) {
      const z = zones.find((zz) => zz.id === id);
      const g = z ? parseGeometry(z.boundary) : null;
      if (g) feats.push({ type: "Feature", properties: { id }, geometry: g });
    }
    (map.current.getSource(SRC_TOOL_HL) as mapboxgl.GeoJSONSource)?.setData({
      type: "FeatureCollection",
      // Hide the highlight once a split preview is showing (it covers the zone).
      features: splitPieces ? [] : feats,
    });
    (map.current.getSource(SRC_SPLIT_PREVIEW) as mapboxgl.GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: splitPieces
        ? [
            { ...splitPieces.a, properties: { side: "a" } },
            { ...splitPieces.b, properties: { side: "b" } },
          ]
        : [],
    });
  }, [tool, mergeSel, splitZoneId, splitPieces, zones, mapReady]);

  // Keep the map-click handlers pointing at the current closures.
  useEffect(() => {
    startEditZoneRef.current = startEditZone;
    toolClickRef.current = handleToolClick;
    splitLineRef.current = handleSplitLine;
    toolRef.current = tool;
  });

  // ---- Drawing + saving zones ----

  // Enter the snapping draw mode with the given snap targets. ('snap_polygon'
  // isn't in the built-in DrawMode union, so cast the changeMode call.)
  function enterSnapPolygon(targets: SnapTarget[]) {
    (
      draw.current as unknown as {
        changeMode: (mode: string, opts?: object) => void;
      } | null
    )?.changeMode("snap_polygon", { snapTargets: targets });
  }

  function startDrawZone() {
    if (!selectedMapId) {
      setMessage("Error: pick a map first.");
      return;
    }
    cancelPending();
    cancelPendingBoundary();
    cancelTool();
    setFillGap(null);
    drawTarget.current = "zone";
    justCreated.current = false;
    setDrawingMode("zone");
    // Snap new zones to existing zones + the map boundary.
    enterSnapPolygon(buildSnapTargets(zones, selectedMap?.boundary));
    setMessage(
      "Click to place points; they snap to nearby borders. Double-click (or Enter) to finish."
    );
  }

  function startDrawBoundary() {
    if (!selectedMapId) {
      setMessage("Error: pick a map first.");
      return;
    }
    cancelPending();
    cancelPendingBoundary();
    cancelTool();
    setFillGap(null);
    drawTarget.current = "boundary";
    justCreated.current = false;
    setRedrawingBoundary(true); // hide the old frame while drawing the new one
    setDrawingMode("boundary");
    // Snap the boundary to existing zones so it hugs them.
    enterSnapPolygon(buildSnapTargets(zones));
    setMessage("Draw the map's outer frame; double-click (or Enter) to finish.");
  }

  // Abort an armed draw before it's finished (explicit Cancel button).
  function cancelDrawing() {
    justCreated.current = false;
    cancelling.current = true;
    try {
      draw.current?.changeMode("simple_select"); // discards the in-progress shape
    } catch {
      /* not in a draw mode */
    }
    cancelling.current = false;
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

  // Create a whole new map from an uploaded GeoJSON: one polygon feature per
  // zone, plus a boundary derived from the union of those zones. Self-contained
  // — the new map owns exactly these zones, so nothing is mixed across maps.
  async function importMapFromFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setCreatingBusy(true);
    try {
      const geojson = JSON.parse(await file.text());
      const parsed = parseZonesFromGeojson(geojson);
      if (parsed.length === 0) {
        setMessage("Error: no polygons found in that file.");
        setCreatingBusy(false);
        return;
      }

      const mapName =
        newMapName.trim() ||
        file.name.replace(/\.(geo)?json$/i, "") ||
        "Imported map";
      const newMapId = `map_${slugify(mapName)}_${Date.now().toString(36)}`;

      // Boundary = union of the imported zones.
      let boundaryStr: string | undefined;
      try {
        const feats = parsed.map((z) => ({
          type: "Feature" as const,
          properties: {},
          geometry: z.geometry,
        }));
        const merged =
          feats.length === 1
            ? feats[0]
            : union({ type: "FeatureCollection", features: feats });
        if (merged) boundaryStr = JSON.stringify(merged.geometry);
      } catch {
        /* no boundary if union fails */
      }

      const mapCenter =
        centerFromFeatures(
          parsed.map((z) => ({
            type: "Feature",
            properties: {},
            geometry: z.geometry,
          }))
        ) || defaultCenterFor(cityId);

      const mapDoc: Record<string, unknown> = {
        id: newMapId,
        name: mapName,
        city: cityId,
        is_active: false,
        created_at: serverTimestamp(),
        map_center: mapCenter,
      };
      if (boundaryStr) mapDoc.boundary = boundaryStr;
      if (newMapBorough.trim()) mapDoc.borough = newMapBorough.trim();
      if (newMapDesc.trim()) mapDoc.description = newMapDesc.trim();
      await setDoc(doc(db, "maps", newMapId), mapDoc);

      // Write zones in batches (Firestore caps a batch at 500 ops).
      let batch = writeBatch(db);
      let n = 0;
      for (let i = 0; i < parsed.length; i++) {
        const z = parsed[i];
        const zid = `zone_${newMapId}_${Date.now().toString(36)}${i}`;
        batch.set(doc(db, "zones", zid), {
          id: zid,
          map_id: newMapId,
          name: z.name,
          city: cityId,
          boundary: JSON.stringify(z.geometry),
          center_lat: z.center_lat,
          center_lng: z.center_lng,
          culture_tags: z.culture_tags,
          transit_lines: z.transit_lines,
          landmarks: z.landmarks,
          difficulty_rating: z.difficulty_rating,
          ...(z.district_number != null
            ? { district_number: z.district_number }
            : {}),
          ...(z.nta_code ? { nta_code: z.nta_code } : {}),
        });
        if (++n >= 450) {
          await batch.commit();
          batch = writeBatch(db);
          n = 0;
        }
      }
      if (n > 0) await batch.commit();

      setMaps((prev) =>
        [
          ...prev,
          {
            id: newMapId,
            name: mapName,
            is_active: false,
            boundary: boundaryStr,
            map_center: mapCenter,
            borough: newMapBorough.trim() || undefined,
            description: newMapDesc.trim() || undefined,
          },
        ].sort((a, b) => a.name.localeCompare(b.name))
      );
      setMode("open");
      setSelectedMapId(newMapId);
      setNewMapName("");
      setNewMapBorough("");
      setNewMapDesc("");
      setMessage(
        `Imported "${mapName}" with ${parsed.length} zone${
          parsed.length === 1 ? "" : "s"
        }${boundaryStr ? " + boundary" : ""}.`
      );
    } catch (err) {
      setMessage("Error importing map: " + (err as Error).message);
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
    setDeleteConfirm(null);
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

  // Delete the whole map and every zone that belongs to it. Destructive and
  // irreversible, so it's a two-step flow: the first click looks up an accurate
  // zone count and shows an inline confirm box; nothing is deleted until the
  // admin explicitly clicks the confirm button.
  async function askDeleteMap() {
    if (!selectedMap) return;
    setEmBusy(true);
    try {
      const [zoneSnap, gameSnap] = await Promise.all([
        getDocs(query(collection(db, "zones"), where("map_id", "==", selectedMap.id))),
        getDocs(query(collection(db, "games"), where("map_id", "==", selectedMap.id))),
      ]);
      let liveGames = 0;
      let endedGames = 0;
      gameSnap.forEach((g) => {
        if (g.data().status === "ended") endedGames++;
        else liveGames++;
      });
      setDeleteConfirm({ zoneCount: zoneSnap.size, liveGames, endedGames });
    } catch (err) {
      setMessage("Error checking map zones: " + (err as Error).message);
    }
    setEmBusy(false);
  }

  async function confirmDeleteMap() {
    if (!selectedMap || !deleteConfirm || deleteConfirm.liveGames > 0) return;
    setEmBusy(true);
    try {
      // A game may have started since the confirm box opened — re-check.
      const live = await liveGamesOnMap(selectedMap.id);
      if (live > 0) {
        setDeleteConfirm({ ...deleteConfirm, liveGames: live });
        setEmBusy(false);
        return;
      }
      // Re-read so we delete exactly what exists now, not a stale list.
      const zoneSnap = await getDocs(
        query(collection(db, "zones"), where("map_id", "==", selectedMap.id))
      );
      const zoneCount = zoneSnap.size;

      const batch = writeBatch(db);
      zoneSnap.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(doc(db, "maps", selectedMap.id));
      await batch.commit();

      const deletedName = selectedMap.name;
      setMaps((prev) => prev.filter((m) => m.id !== selectedMap.id));
      setSelectedMapId("");
      setDeleteConfirm(null);
      setEditMapOpen(false);
      setMessage(`Deleted map "${deletedName}" and ${zoneCount} zone(s).`);
    } catch (err) {
      setMessage("Error deleting map: " + (err as Error).message);
    }
    setEmBusy(false);
  }

  // Absorb the selected gap sliver into the chosen zone: zone := zone ∪ sliver.
  // One merge-write of boundary + recomputed center; local state updates so the
  // gap overlay refreshes immediately.
  async function confirmFillGap() {
    if (!fillGap || !fillGap.targetId) return;
    const target = zones.find((z) => z.id === fillGap.targetId);
    const zg = target ? parseGeometry(target.boundary) : null;
    const zf = zg ? toPolyFeature(zg) : null;
    if (!target || !zf) return;
    setFillBusy(true);
    try {
      const merged = union({
        type: "FeatureCollection",
        features: [zf, fillGap.piece],
      });
      if (!merged) throw new Error("could not merge shapes");
      const c = center(merged);
      const update = {
        boundary: JSON.stringify(merged.geometry),
        center_lat: Math.round(c.geometry.coordinates[1] * 1e6) / 1e6,
        center_lng: Math.round(c.geometry.coordinates[0] * 1e6) / 1e6,
      };
      await setDoc(doc(db, "zones", target.id), update, { merge: true });
      setZones((prev) => prev.map((z) => (z.id === target.id ? { ...z, ...update } : z)));
      setFillGap(null);
      setMessage(`Filled gap into "${target.name}".`);
    } catch (err) {
      setMessage("Error filling gap: " + (err as Error).message);
    }
    setFillBusy(false);
  }

  // ---- Merge / split tools ----

  // Count games on this map that are still in progress. Changing zone ids
  // under a live game would break it, so merge/split refuse while any exist.
  async function liveGamesOnMap(mapId: string): Promise<number> {
    const snap = await getDocs(query(collection(db, "games"), where("map_id", "==", mapId)));
    let n = 0;
    snap.forEach((g) => {
      if (g.data().status !== "ended") n++;
    });
    return n;
  }

  function startMergeTool() {
    cancelPending();
    cancelPendingBoundary();
    cancelTool();
    setFillGap(null);
    setTool("merge");
    setMergeSel([]);
    setMessage("Click the zone to keep, then a neighboring zone to merge into it.");
  }

  function startSplitTool() {
    cancelPending();
    cancelPendingBoundary();
    cancelTool();
    setFillGap(null);
    setTool("split");
    setSplitZoneId(null);
    setSplitPhase("pick");
    setMessage("Click the zone you want to split.");
  }

  function cancelTool() {
    if (splitDrawId.current) {
      try {
        draw.current?.delete(splitDrawId.current);
      } catch {
        /* already gone */
      }
      splitDrawId.current = null;
    }
    if (drawTarget.current === "split") {
      drawTarget.current = null;
      cancelling.current = true;
      try {
        draw.current?.changeMode("simple_select");
      } catch {
        /* not in a draw mode */
      }
      cancelling.current = false;
    }
    setTool(null);
    setMergeSel([]);
    setMergeName("");
    setSplitZoneId(null);
    setSplitPhase("pick");
    setSplitPieces(null);
    setSplitNameA("");
    setSplitNameB("");
  }

  // A zone was clicked while a tool is active.
  function handleToolClick(zoneId: string) {
    const z = zones.find((zz) => zz.id === zoneId);
    if (!z) return;
    if (tool === "merge") {
      if (mergeSel.length === 0) {
        setMergeSel([zoneId]);
        setMergeName(z.name || "");
        setMessage(`Keeping "${z.name}". Now click a neighboring zone to merge into it.`);
        return;
      }
      if (mergeSel.length >= 2 || zoneId === mergeSel[0]) return;
      const keep = zones.find((zz) => zz.id === mergeSel[0]);
      const kg = keep ? parseGeometry(keep.boundary) : null;
      const zg = parseGeometry(z.boundary);
      if (!kg || !zg || !touches(kg, zg)) {
        setMessage(`"${z.name}" doesn't share a border with "${keep?.name}". Pick an adjacent zone.`);
        return;
      }
      setMergeSel([mergeSel[0], zoneId]);
      setMessage("");
      return;
    }
    if (tool === "split") {
      if (splitPhase !== "pick") return;
      setSplitZoneId(zoneId);
      setSplitPhase("line");
      drawTarget.current = "split";
      justCreated.current = false;
      try {
        draw.current?.changeMode("draw_line_string");
      } catch {
        setMessage("Error: couldn't start the line tool.");
        setSplitPhase("pick");
        return;
      }
      setMessage(
        `Draw a line all the way across "${z.name}". Double-click (or Enter) to finish, Esc to cancel.`
      );
    }
  }

  // The split line was finished — cut the zone and show a preview.
  function handleSplitLine(lineGeom: GeoJSON.Geometry) {
    const z = zones.find((zz) => zz.id === splitZoneId);
    const zg = z ? parseGeometry(z.boundary) : null;
    const retry = (why: string) => {
      if (splitDrawId.current) {
        try {
          draw.current?.delete(splitDrawId.current);
        } catch {
          /* gone */
        }
        splitDrawId.current = null;
      }
      setSplitPhase("pick");
      setMessage(why + " Click the zone to try again.");
    };
    if (!z || !zg || lineGeom.type !== "LineString") {
      retry("Couldn't read the line.");
      return;
    }
    const pieces = splitPolygonByLine(zg, lineGeom);
    if (!pieces) {
      retry("The line must cross the whole zone, leaving a piece on each side.");
      return;
    }
    setSplitPieces(pieces);
    setSplitNameA(z.name || "");
    setSplitNameB(`${z.name || "Zone"} 2`);
    setSplitPhase("preview");
    setMessage("");
  }

  // Merge: keep := keep ∪ absorb, then delete absorb. One atomic batch.
  async function confirmMerge() {
    if (mergeSel.length !== 2 || !selectedMapId) return;
    const keep = zones.find((z) => z.id === mergeSel[0]);
    const absorb = zones.find((z) => z.id === mergeSel[1]);
    const kg = keep ? parseGeometry(keep.boundary) : null;
    const ag = absorb ? parseGeometry(absorb.boundary) : null;
    const kf = kg ? toPolyFeature(kg) : null;
    const af = ag ? toPolyFeature(ag) : null;
    if (!keep || !absorb || !kf || !af) {
      setMessage("Error: one of the zones has no usable polygon.");
      return;
    }
    setToolBusy(true);
    try {
      const live = await liveGamesOnMap(selectedMapId);
      if (live > 0) {
        setMessage(`Can't merge: ${live} game(s) in progress on this map. End them first.`);
        setToolBusy(false);
        return;
      }
      const merged = union({ type: "FeatureCollection", features: [kf, af] });
      if (!merged) throw new Error("could not merge shapes");
      const c = center(merged);
      const uniq = (arr: string[]) => Array.from(new Set(arr));
      const update = {
        name: mergeName.trim() || keep.name,
        boundary: JSON.stringify(merged.geometry),
        center_lat: Math.round(c.geometry.coordinates[1] * 1e6) / 1e6,
        center_lng: Math.round(c.geometry.coordinates[0] * 1e6) / 1e6,
        culture_tags: uniq([...(keep.culture_tags || []), ...(absorb.culture_tags || [])]),
        transit_lines: uniq([...(keep.transit_lines || []), ...(absorb.transit_lines || [])]),
        landmarks: uniq([...(keep.landmarks || []), ...(absorb.landmarks || [])]),
      };
      const batch = writeBatch(db);
      batch.set(doc(db, "zones", keep.id), update, { merge: true });
      batch.delete(doc(db, "zones", absorb.id));
      await batch.commit();
      setZones((prev) =>
        prev
          .filter((z) => z.id !== absorb.id)
          .map((z) => (z.id === keep.id ? { ...z, ...update } : z))
      );
      setMessage(`Merged "${absorb.name}" into "${update.name}".`);
      cancelTool();
    } catch (err) {
      setMessage("Error merging: " + (err as Error).message);
    }
    setToolBusy(false);
  }

  // Split: original zone keeps piece A; piece B becomes a new zone doc that
  // copies the original's metadata. One atomic batch.
  async function confirmSplit() {
    if (!splitPieces || !splitZoneId || !selectedMapId) return;
    const z = zones.find((zz) => zz.id === splitZoneId);
    if (!z) return;
    setToolBusy(true);
    try {
      const live = await liveGamesOnMap(selectedMapId);
      if (live > 0) {
        setMessage(`Can't split: ${live} game(s) in progress on this map. End them first.`);
        setToolBusy(false);
        return;
      }
      const ca = center(splitPieces.a);
      const cb = center(splitPieces.b);
      const updateA = {
        name: splitNameA.trim() || z.name,
        boundary: JSON.stringify(splitPieces.a.geometry),
        center_lat: Math.round(ca.geometry.coordinates[1] * 1e6) / 1e6,
        center_lng: Math.round(ca.geometry.coordinates[0] * 1e6) / 1e6,
      };
      const newId = `zone_${selectedMapId}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
      // Copy metadata but not source-specific identifiers (NTA code, district
      // number, full name) — those described the original shape, not half of it.
      const { nta_code: _n, district_number: _d, full_name: _f, ...inherit } = z;
      void _n; void _d; void _f;
      const newZone: Zone = {
        ...inherit,
        id: newId,
        name: splitNameB.trim() || `${z.name} 2`,
        boundary: JSON.stringify(splitPieces.b.geometry),
        center_lat: Math.round(cb.geometry.coordinates[1] * 1e6) / 1e6,
        center_lng: Math.round(cb.geometry.coordinates[0] * 1e6) / 1e6,
      };
      const batch = writeBatch(db);
      batch.set(doc(db, "zones", z.id), updateA, { merge: true });
      batch.set(doc(db, "zones", newId), newZone);
      await batch.commit();
      setZones((prev) => [...prev.map((zz) => (zz.id === z.id ? { ...zz, ...updateA } : zz)), newZone]);
      setMessage(`Split "${z.name}" into "${updateA.name}" and "${newZone.name}".`);
      cancelTool();
    } catch (err) {
      setMessage("Error splitting: " + (err as Error).message);
    }
    setToolBusy(false);
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
    setConfirmZoneDeleteId(null);
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
    if (drawingMode || pendingBoundary || pendingGeometry || tool) return;
    setFillGap(null);
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
      // Vertex drags snap to the OTHER zones + the boundary — excluding the
      // zone being edited, or its vertices would stick to their own old border.
      const targets = buildSnapTargets(
        zones.filter((zz) => zz.id !== zoneId),
        selectedMap?.boundary
      );
      try {
        (
          draw.current as unknown as {
            changeMode: (mode: string, opts?: object) => void;
          }
        ).changeMode("snap_direct_select", {
          featureId: drawId,
          snapTargets: targets,
        });
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
  // Runs only after the inline confirm (no browser popup).
  async function deleteZone(zoneId: string) {
    const z = zones.find((zz) => zz.id === zoneId);
    setConfirmZoneDeleteId(null);
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
        background: "var(--paper)",
        color: "var(--ink)",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      }}
    >
      {/* Control panel */}
      <div
        style={{
          width: 320,
          minWidth: 320,
          borderRight: "1px solid var(--line)",
          padding: 20,
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 800, marginBottom: 4 }}>
          Zone Builder
        </h1>
        <p style={{ color: "var(--ink-muted)", fontSize: "0.82rem", marginBottom: 12 }}>
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
            background: "var(--surface)",
            border: "1px solid var(--line)",
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
              {creatingBusy ? "Creating…" : "Create empty map"}
            </button>
            <p style={{ color: "var(--ink-faint)", fontSize: "0.75rem", marginTop: 10 }}>
              Creates a draft map, then opens it so you can draw its boundary and
              zones.
            </p>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "18px 0",
                color: "var(--ink-faint)",
                fontSize: "0.75rem",
              }}
            >
              <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
              or
              <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>

            <label
              style={{
                ...secondaryFullBtnStyle,
                marginTop: 0,
                display: "block",
                textAlign: "center",
                opacity: creatingBusy ? 0.6 : 1,
                cursor: creatingBusy ? "not-allowed" : "pointer",
              }}
            >
              {creatingBusy ? "Importing…" : "⬆ Import map from GeoJSON"}
              <input
                type="file"
                accept=".geojson,.json"
                onChange={importMapFromFile}
                disabled={creatingBusy}
                style={{ display: "none" }}
              />
            </label>
            <p style={{ color: "var(--ink-faint)", fontSize: "0.75rem", marginTop: 8 }}>
              One polygon per zone. Creates a new draft map containing just those
              zones, with a boundary derived from them. Uses the name above, or
              the file name.
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
              style={{ ...inputStyle, color: selectedMapId ? "var(--ink)" : "var(--ink-muted)" }}
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
              <p style={{ color: "var(--ink-faint)", fontSize: "0.75rem", marginTop: 10 }}>
                Pick a map to edit its zones and boundary.
              </p>
            )}

        {selectedMap && (
          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              background: "rgba(var(--ink-rgb), 0.02)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              fontSize: "0.82rem",
            }}
          >
            <div style={{ color: "var(--ink-muted)", marginBottom: 6 }}>
              {loadingZones ? "Loading zones…" : `${zones.length} zone(s)`}
            </div>
            <div style={{ color: selectedMap.boundary ? "var(--green)" : "var(--red)" }}>
              {selectedMap.boundary
                ? "✓ boundary set"
                : "no boundary drawn yet"}
            </div>
            {selectedMap.boundary && gapPercent !== null && (
              <div
                style={{
                  marginTop: 4,
                  color: gapPercent === 0 ? "var(--green)" : "#FF6B35",
                }}
              >
                {gapPercent === 0
                  ? "✓ fully covered"
                  : `~${gapPercent}% uncovered — click an orange area to fill it`}
              </div>
            )}
            {fillGap && (
              <div
                style={{
                  marginTop: 10,
                  background: "rgba(var(--marigold-rgb), 0.08)",
                  border: "1px solid rgba(var(--marigold-rgb), 0.4)",
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <p style={{ color: "var(--marigold)", fontWeight: 700, fontSize: "0.85rem", margin: "0 0 6px" }}>
                  Fill gap (~{Math.round(area(fillGap.piece)).toLocaleString()} m²)
                </p>
                {fillGap.candidates.length === 0 ? (
                  <p style={{ color: "var(--ink-soft)", fontSize: "0.78rem", margin: "0 0 10px", lineHeight: 1.5 }}>
                    No zone touches this area. Draw a new zone over it instead.
                  </p>
                ) : (
                  <>
                    <p style={{ color: "var(--ink-soft)", fontSize: "0.78rem", margin: "0 0 8px" }}>
                      Add this area to:
                    </p>
                    <select
                      value={fillGap.targetId}
                      onChange={(e) => setFillGap({ ...fillGap, targetId: e.target.value })}
                      disabled={fillBusy}
                      style={{
                        width: "100%",
                        background: "var(--surface)",
                        color: "var(--ink-soft)",
                        border: "1px solid var(--line-strong)",
                        borderRadius: 6,
                        padding: "8px 10px",
                        fontFamily: "inherit",
                        fontSize: "0.85rem",
                        marginBottom: 10,
                        boxSizing: "border-box",
                      }}
                    >
                      {fillGap.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  {fillGap.candidates.length > 0 && (
                    <button
                      onClick={confirmFillGap}
                      disabled={fillBusy || !fillGap.targetId}
                      style={{
                        flex: 1,
                        background: "var(--marigold)",
                        color: "var(--paper)",
                        border: "none",
                        borderRadius: 8,
                        padding: "9px 12px",
                        fontWeight: 700,
                        fontSize: "0.85rem",
                        cursor: fillBusy ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      {fillBusy ? "Filling…" : "Fill gap"}
                    </button>
                  )}
                  <button
                    onClick={() => setFillGap(null)}
                    disabled={fillBusy}
                    style={fillGap.candidates.length === 0 ? { ...secondaryBtnStyle, flex: 1 } : secondaryBtnStyle}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  color: selectedMap.is_active ? "var(--green)" : "var(--ink-muted)",
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
                    : "var(--green)",
                  color: selectedMap.is_active ? "var(--ink-muted)" : "var(--paper)",
                  border: selectedMap.is_active
                    ? "1px solid var(--line-strong)"
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
                background: "rgba(var(--ink-rgb), 0.02)",
                border: "1px solid var(--line)",
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
                  onClick={() => { setEditMapOpen(false); setDeleteConfirm(null); }}
                  disabled={emBusy}
                  style={secondaryBtnStyle}
                >
                  Cancel
                </button>
              </div>

              <div
                style={{
                  marginTop: 14,
                  paddingTop: 14,
                  borderTop: "1px solid var(--line)",
                }}
              >
                {deleteConfirm === null ? (
                  <>
                    <button
                      onClick={askDeleteMap}
                      disabled={emBusy}
                      style={{
                        width: "100%",
                        background: "rgba(var(--red-rgb), 0.1)",
                        color: "var(--red)",
                        border: "1px solid rgba(var(--red-rgb), 0.3)",
                        borderRadius: 8,
                        padding: "9px 16px",
                        fontWeight: 700,
                        fontSize: "0.85rem",
                        cursor: emBusy ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Delete this map &amp; its zones
                    </button>
                    <p style={{ color: "var(--ink-faint)", fontSize: "0.72rem", marginTop: 6 }}>
                      Permanent — removes the map and every zone on it.
                    </p>
                  </>
                ) : (
                  <div
                    style={{
                      background: "rgba(var(--red-rgb), 0.08)",
                      border: "1px solid rgba(var(--red-rgb), 0.4)",
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <p style={{ color: "var(--red)", fontWeight: 700, fontSize: "0.85rem", margin: "0 0 6px" }}>
                      Delete "{selectedMap?.name}"{selectedMap?.is_active ? " (PUBLISHED)" : ""}?
                    </p>
                    {deleteConfirm.liveGames > 0 ? (
                      <p style={{ color: "var(--ink-soft)", fontSize: "0.78rem", margin: "0 0 12px", lineHeight: 1.5 }}>
                        <strong style={{ color: "var(--red)" }}>Can't delete:</strong>{" "}
                        {deleteConfirm.liveGames} game{deleteConfirm.liveGames === 1 ? " is" : "s are"}{" "}
                        in progress on this map. End {deleteConfirm.liveGames === 1 ? "it" : "them"} first.
                      </p>
                    ) : (
                      <p style={{ color: "var(--ink-soft)", fontSize: "0.78rem", margin: "0 0 12px", lineHeight: 1.5 }}>
                        This permanently removes the map and its{" "}
                        <strong>{deleteConfirm.zoneCount} zone{deleteConfirm.zoneCount === 1 ? "" : "s"}</strong>.
                        It can't be undone.
                        {deleteConfirm.endedGames > 0 && (
                          <>
                            {" "}
                            <strong style={{ color: "var(--marigold)" }}>
                              {deleteConfirm.endedGames} finished game{deleteConfirm.endedGames === 1 ? "" : "s"}
                            </strong>{" "}
                            used this map. Games created since zone snapshots (Aug 2026) keep their
                            own copy of the zones and are unaffected; older games will show zone IDs
                            instead of names on their results page.
                          </>
                        )}
                      </p>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      {deleteConfirm.liveGames === 0 && (
                      <button
                        onClick={confirmDeleteMap}
                        disabled={emBusy}
                        style={{
                          flex: 1,
                          background: "var(--red)",
                          color: "var(--ink)",
                          border: "none",
                          borderRadius: 8,
                          padding: "9px 12px",
                          fontWeight: 700,
                          fontSize: "0.85rem",
                          cursor: emBusy ? "not-allowed" : "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {emBusy ? "Deleting…" : "Yes, delete permanently"}
                      </button>
                      )}
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        disabled={emBusy}
                        style={deleteConfirm.liveGames > 0 ? { ...secondaryBtnStyle, flex: 1 } : secondaryBtnStyle}
                      >
                        {deleteConfirm.liveGames > 0 ? "OK" : "Cancel"}
                      </button>
                    </div>
                  </div>
                )}
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
                background: "rgba(var(--ink-rgb), 0.02)",
                border: "1px solid var(--line)",
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
              <p style={{ color: "var(--ink-faint)", fontSize: "0.75rem", marginTop: 8 }}>
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
                  ? "rgba(var(--marigold-rgb), 0.1)"
                  : "rgba(var(--green-rgb), 0.1)",
              border: `1px solid ${
                drawingMode === "boundary"
                  ? "rgba(var(--marigold-rgb), 0.5)"
                  : "rgba(var(--green-rgb), 0.5)"
              }`,
              borderRadius: 10,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              ✎ Drawing {drawingMode === "boundary" ? "map boundary" : "zone"}…
            </div>
            <div
              style={{ color: "var(--ink-muted)", fontSize: "0.8rem", marginBottom: 12 }}
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

        {/* Merge / split tool panel */}
        {selectedMap && tool && (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              background: "rgba(var(--pink-rgb), 0.1)",
              border: "1px solid rgba(var(--pink-rgb), 0.5)",
              borderRadius: 10,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              {tool === "merge" ? "⧈ Merge zones" : "✂ Split zone"}
            </div>
            {tool === "merge" && (
              <>
                <div style={{ color: "var(--ink-muted)", fontSize: "0.8rem", marginBottom: 10, lineHeight: 1.5 }}>
                  {mergeSel.length === 0 && "Click the zone to keep."}
                  {mergeSel.length === 1 && (
                    <>
                      Keeping <strong style={{ color: "var(--ink-soft)" }}>{zones.find((z) => z.id === mergeSel[0])?.name}</strong>.
                      Now click a neighboring zone to merge into it.
                    </>
                  )}
                  {mergeSel.length === 2 && (
                    <>
                      <strong style={{ color: "var(--ink-soft)" }}>{zones.find((z) => z.id === mergeSel[1])?.name}</strong>{" "}
                      will be removed and its area added to{" "}
                      <strong style={{ color: "var(--ink-soft)" }}>{zones.find((z) => z.id === mergeSel[0])?.name}</strong>.
                      Tags, transit and landmarks are combined.
                    </>
                  )}
                </div>
                {mergeSel.length === 2 && (
                  <>
                    <label style={{ color: "var(--ink-muted)", fontSize: "0.75rem" }}>Merged zone name</label>
                    <input
                      value={mergeName}
                      onChange={(e) => setMergeName(e.target.value)}
                      disabled={toolBusy}
                      style={toolInputStyle}
                    />
                  </>
                )}
              </>
            )}
            {tool === "split" && (
              <>
                <div style={{ color: "var(--ink-muted)", fontSize: "0.8rem", marginBottom: 10, lineHeight: 1.5 }}>
                  {splitPhase === "pick" && "Click the zone you want to split."}
                  {splitPhase === "line" && (
                    <>
                      Draw a line all the way across{" "}
                      <strong style={{ color: "var(--ink-soft)" }}>{zones.find((z) => z.id === splitZoneId)?.name}</strong>.
                      Double-click (or Enter) to finish, Esc to cancel.
                    </>
                  )}
                  {splitPhase === "preview" && "Name the two pieces (green and yellow on the map), then confirm."}
                </div>
                {splitPhase === "preview" && splitPieces && (
                  <>
                    <label style={{ color: "var(--green)", fontSize: "0.75rem" }}>
                      Green piece (keeps this zone's id) — {Math.round(area(splitPieces.a)).toLocaleString()} m²
                    </label>
                    <input value={splitNameA} onChange={(e) => setSplitNameA(e.target.value)} disabled={toolBusy} style={toolInputStyle} />
                    <label style={{ color: "var(--marigold)", fontSize: "0.75rem" }}>
                      Yellow piece (new zone) — {Math.round(area(splitPieces.b)).toLocaleString()} m²
                    </label>
                    <input value={splitNameB} onChange={(e) => setSplitNameB(e.target.value)} disabled={toolBusy} style={toolInputStyle} />
                  </>
                )}
              </>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {tool === "merge" && mergeSel.length === 2 && (
                <button
                  onClick={confirmMerge}
                  disabled={toolBusy}
                  style={{ ...primaryBtnStyle, marginTop: 0, flex: 1, background: "var(--pink)", color: "var(--ink)" }}
                >
                  {toolBusy ? "Merging…" : "Merge zones"}
                </button>
              )}
              {tool === "split" && splitPhase === "preview" && (
                <button
                  onClick={confirmSplit}
                  disabled={toolBusy}
                  style={{ ...primaryBtnStyle, marginTop: 0, flex: 1, background: "var(--pink)", color: "var(--ink)" }}
                >
                  {toolBusy ? "Splitting…" : "Split zone"}
                </button>
              )}
              <button onClick={cancelTool} disabled={toolBusy} style={{ ...secondaryBtnStyle, flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Draw actions */}
        {selectedMap && !drawingMode && !pendingGeometry && !pendingBoundary && !tool && (
          <>
            <button onClick={startDrawZone} style={primaryBtnStyle}>
              ✏️ Draw a zone
            </button>
            {zones.length >= 2 && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={startMergeTool} style={{ ...secondaryBtnStyle, flex: 1 }}>
                  ⧈ Merge zones
                </button>
                <button onClick={startSplitTool} style={{ ...secondaryBtnStyle, flex: 1 }}>
                  ✂ Split zone
                </button>
              </div>
            )}
            {zones.length === 1 && (
              <button onClick={startSplitTool} style={secondaryFullBtnStyle}>
                ✂ Split zone
              </button>
            )}
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
                        background: "rgba(var(--ink-rgb), 0.02)",
                        border: "1px solid var(--line)",
                        borderRadius: 8,
                        padding: "8px 10px",
                      }}
                    >
                      {confirmZoneDeleteId === z.id ? (
                        <>
                          <span style={{ flex: 1, color: "var(--red)", fontSize: "0.8rem", fontWeight: 600 }}>
                            Delete "{z.name || "Untitled zone"}"?
                          </span>
                          <button onClick={() => deleteZone(z.id)} disabled={saving} style={zoneRowDangerBtn}>
                            Delete
                          </button>
                          <button onClick={() => setConfirmZoneDeleteId(null)} disabled={saving} style={zoneRowQuietBtn}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => (tool ? handleToolClick(z.id) : startEditZone(z.id))}
                            title={tool ? "Select this zone" : "Edit this zone"}
                            style={{
                              flex: 1,
                              textAlign: "left",
                              background: "none",
                              border: "none",
                              color: "var(--ink-soft)",
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
                          {!tool && (
                          <button
                            onClick={() => setConfirmZoneDeleteId(z.id)}
                            title="Delete this zone"
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--red-deep)",
                              cursor: "pointer",
                              fontSize: "0.9rem",
                              fontFamily: "inherit",
                              padding: "0 4px",
                            }}
                          >
                            ✕
                          </button>
                          )}
                        </>
                      )}
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
              background: "rgba(var(--marigold-rgb), 0.06)",
              border: "1px solid rgba(var(--marigold-rgb), 0.35)",
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
                  background: "rgba(var(--red-rgb), 0.1)",
                  border: "1px solid rgba(var(--red-rgb), 0.4)",
                  borderRadius: 8,
                  fontSize: "0.8rem",
                  color: "var(--red)",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  ⚠ Overlaps {overlaps.length} saved zone
                  {overlaps.length > 1 ? "s" : ""}
                </div>
                <div style={{ color: "var(--red)", lineHeight: 1.5 }}>
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
                    color: "var(--red)",
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
                    background: "var(--green)",
                    color: "var(--paper)",
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
                      background: blocked ? "var(--line-strong)" : primaryBtnStyle.background,
                      color: blocked ? "var(--ink-muted)" : primaryBtnStyle.color,
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

            {editingZoneId && confirmZoneDeleteId !== editingZoneId && (
              <button
                onClick={() => setConfirmZoneDeleteId(editingZoneId)}
                disabled={saving}
                style={{
                  marginTop: 10,
                  width: "100%",
                  background: "rgba(var(--red-rgb), 0.1)",
                  color: "var(--red)",
                  border: "1px solid rgba(var(--red-rgb), 0.3)",
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
            {editingZoneId && confirmZoneDeleteId === editingZoneId && (
              <div
                style={{
                  marginTop: 10,
                  background: "rgba(var(--red-rgb), 0.08)",
                  border: "1px solid rgba(var(--red-rgb), 0.4)",
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <p style={{ color: "var(--red)", fontWeight: 700, fontSize: "0.85rem", margin: "0 0 6px" }}>
                  Delete "{zoneName.trim() || "this zone"}"?
                </p>
                <p style={{ color: "var(--ink-soft)", fontSize: "0.78rem", margin: "0 0 12px", lineHeight: 1.5 }}>
                  This permanently removes the zone. It can't be undone.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => deleteZone(editingZoneId)}
                    disabled={saving}
                    style={{
                      flex: 1,
                      background: "var(--red)",
                      color: "var(--ink)",
                      border: "none",
                      borderRadius: 8,
                      padding: "9px 12px",
                      fontWeight: 700,
                      fontSize: "0.85rem",
                      cursor: saving ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {saving ? "Deleting…" : "Yes, delete zone"}
                  </button>
                  <button onClick={() => setConfirmZoneDeleteId(null)} disabled={saving} style={secondaryBtnStyle}>
                    Cancel
                  </button>
                </div>
              </div>
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
                ? "rgba(var(--red-rgb), 0.1)"
                : "rgba(var(--green-rgb), 0.1)",
              border: `1px solid ${
                message.startsWith("Error")
                  ? "rgba(var(--red-rgb), 0.3)"
                  : "rgba(var(--green-rgb), 0.3)"
              }`,
              borderRadius: 8,
              padding: "10px 12px",
              color: message.startsWith("Error") ? "var(--red)" : "var(--green)",
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


const labelStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--ink-muted)",
  display: "block",
  marginBottom: 6,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--line-strong)",
  color: "var(--ink)",
  padding: "9px 12px",
  borderRadius: 8,
  fontSize: "0.88rem",
  width: "100%",
  boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
  marginTop: 16,
  width: "100%",
  background: "var(--green)",
  color: "var(--paper)",
  border: "none",
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 700,
  fontSize: "0.9rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const zoneRowDangerBtn: React.CSSProperties = {
  background: "var(--red)",
  color: "var(--ink)",
  border: "none",
  borderRadius: 6,
  padding: "4px 10px",
  fontWeight: 700,
  fontSize: "0.75rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const zoneRowQuietBtn: React.CSSProperties = {
  background: "none",
  color: "var(--ink-muted)",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  padding: "4px 10px",
  fontWeight: 600,
  fontSize: "0.75rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const toolInputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface)",
  color: "var(--ink-soft)",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  padding: "8px 10px",
  fontFamily: "inherit",
  fontSize: "0.85rem",
  margin: "4px 0 10px",
  boxSizing: "border-box",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--ink-muted)",
  border: "1px solid var(--line-strong)",
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
  // <label> defaults to content-box, so width:100% + padding overflows; pin it.
  boxSizing: "border-box",
  marginTop: 10,
};

// Subtle inline text link between admin pages.
const crossLinkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--blue)",
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
    background: active ? "var(--line)" : "transparent",
    color: active ? "var(--ink)" : "var(--ink-muted)",
    border: "none",
    borderRadius: 7,
    padding: "8px 12px",
    fontWeight: 700,
    fontSize: "0.82rem",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
