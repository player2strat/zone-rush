// =============================================================================
// Zone Rush — Zone Builder snapping
//
// Draw-time and edit-time snapping for mapbox-gl-draw: points placed while
// drawing, and vertices dragged while editing, snap onto nearby zone borders /
// the map boundary (SNAP_PIXELS screen radius) with a pink indicator dot.
// Extracted from ZoneBuilder.tsx; no React state lives here.
// =============================================================================

import mapboxgl from "mapbox-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import type { Zone } from "../types/game";
import { parseGeometry } from "./zoneGeometry";

export const SRC_SNAP = "zb-snap-indicator";

// Snap radius in screen pixels: a point being drawn within this distance of an
// existing zone edge/vertex (or the boundary) snaps onto it, so shared borders
// coincide instead of leaving a gap/overlap.
export const SNAP_PIXELS = 12;

// ---- Snapping (draw-time) --------------------------------------------------

export interface SnapTarget {
  coords: number[][]; // ring coordinates as [lng,lat][]
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
}

// Collect polygon rings (with bboxes) from zones + an optional boundary — the
// geometry a freshly drawn point can snap onto.
export function buildSnapTargets(zones: Zone[], boundaryStr?: string): SnapTarget[] {
  const targets: SnapTarget[] = [];
  const addGeom = (geom: GeoJSON.Geometry | null) => {
    if (!geom) return;
    const rings: number[][][] =
      geom.type === "Polygon"
        ? geom.coordinates
        : geom.type === "MultiPolygon"
        ? geom.coordinates.flat()
        : [];
    for (const ring of rings) {
      if (!ring || ring.length < 2) continue;
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const c of ring) {
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }
      targets.push({ coords: ring, bbox: [minLng, minLat, maxLng, maxLat] });
    }
  };
  for (const z of zones) addGeom(parseGeometry(z.boundary));
  if (boundaryStr) addGeom(parseGeometry(boundaryStr));
  return targets;
}

// Nearest point on screen segment ab to point p (all pixel-space).
function nearestOnSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// Snap lng/lat to the nearest target vertex (priority) or edge within SNAP_PIXELS
// on screen. Returns the snapped [lng,lat], or null if nothing is close enough.
function snapPoint(
  map: mapboxgl.Map,
  targets: SnapTarget[],
  lngLat: [number, number],
  pixels: number
): [number, number] | null {
  const [clng, clat] = lngLat;
  const cursor = map.project(lngLat);
  const M = 0.02; // coarse degree pre-filter so far rings aren't projected

  let best: [number, number] | null = null;
  let bestD = pixels;
  for (const t of targets) {
    const [w, s, e, n] = t.bbox;
    if (clng < w - M || clng > e + M || clat < s - M || clat > n + M) continue;
    for (const c of t.coords) {
      const pt = map.project([c[0], c[1]]);
      const d = Math.hypot(pt.x - cursor.x, pt.y - cursor.y);
      if (d < bestD) {
        bestD = d;
        best = [c[0], c[1]];
      }
    }
  }
  if (best) return best;

  bestD = pixels;
  for (const t of targets) {
    const [w, s, e, n] = t.bbox;
    if (clng < w - M || clng > e + M || clat < s - M || clat > n + M) continue;
    for (let i = 0; i + 1 < t.coords.length; i++) {
      const a = map.project([t.coords[i][0], t.coords[i][1]]);
      const b = map.project([t.coords[i + 1][0], t.coords[i + 1][1]]);
      const np = nearestOnSegment(cursor, a, b);
      const d = Math.hypot(np.x - cursor.x, np.y - cursor.y);
      if (d < bestD) {
        bestD = d;
        const ll = map.unproject([np.x, np.y]);
        best = [ll.lng, ll.lat];
      }
    }
  }
  return best;
}

// Show/clear the dot that marks where the next point will snap.
function updateSnapIndicator(map: mapboxgl.Map, coord: [number, number] | null) {
  const src = map.getSource(SRC_SNAP) as mapboxgl.GeoJSONSource | undefined;
  if (!src) return;
  src.setData(
    coord
      ? {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: coord },
        }
      : { type: "FeatureCollection", features: [] }
  );
}

// The runtime built-in mode implementations. (The shipped types describe a
// different constants object under `.modes`, so cast to the real shape.)
export const BUILTIN_MODES = (
  MapboxDraw as unknown as { modes: Record<string, MapboxDraw.DrawCustomMode> }
).modes;

interface SnapModeState {
  snapTargets: SnapTarget[];
  [k: string]: unknown;
}

// A draw_polygon variant that snaps each placed/previewed point onto nearby
// geometry passed via changeMode('snap_polygon', { snapTargets }).
export function createSnapPolygonMode(): MapboxDraw.DrawCustomMode {
  const base = BUILTIN_MODES.draw_polygon;

  const applySnap = (
    ctx: MapboxDraw.DrawCustomModeThis,
    state: SnapModeState,
    e: { lngLat?: mapboxgl.LngLat }
  ) => {
    const ll = e?.lngLat;
    if (!ll) return;
    const snapped = snapPoint(ctx.map, state.snapTargets, [ll.lng, ll.lat], SNAP_PIXELS);
    updateSnapIndicator(ctx.map, snapped);
    if (snapped) e.lngLat = new mapboxgl.LngLat(snapped[0], snapped[1]);
  };

  return {
    ...base,
    onSetup(opts) {
      const state = base.onSetup!.call(this, opts) as SnapModeState;
      state.snapTargets =
        (opts as { snapTargets?: SnapTarget[] })?.snapTargets || [];
      return state;
    },
    onMouseMove(state, e) {
      applySnap(this, state as SnapModeState, e);
      base.onMouseMove!.call(this, state, e);
    },
    onClick(state, e) {
      applySnap(this, state as SnapModeState, e);
      base.onClick!.call(this, state, e);
    },
    onTap(state, e) {
      applySnap(this, state as SnapModeState, e);
      base.onTap!.call(this, state, e);
    },
    onStop(state) {
      updateSnapIndicator(this.map, null);
      base.onStop!.call(this, state);
    },
  };
}

// A direct_select variant for editing an existing zone: dragging a single
// vertex (or a just-dragged midpoint) snaps it onto neighbor borders. The base
// mode moves vertices by cursor DELTA, so after the base drag we hard-set the
// vertex to the snapped point for exact coincidence — a delta nudge alone would
// leave it off by the cursor-grab offset.
export function createSnapDirectSelectMode(): MapboxDraw.DrawCustomMode {
  const base = BUILTIN_MODES.direct_select;

  interface DirectSelectState extends SnapModeState {
    selectedCoordPaths?: string[];
    feature?: {
      updateCoordinate: (path: string, lng: number, lat: number) => void;
    };
  }

  return {
    ...base,
    onSetup(opts) {
      const state = base.onSetup!.call(this, opts) as DirectSelectState;
      state.snapTargets =
        (opts as { snapTargets?: SnapTarget[] })?.snapTargets || [];
      return state;
    },
    onDrag(state, e) {
      const s = state as DirectSelectState;
      let snapped: [number, number] | null = null;
      const singleVertex =
        Array.isArray(s.selectedCoordPaths) && s.selectedCoordPaths.length === 1;
      if (singleVertex && e?.lngLat) {
        snapped = snapPoint(
          this.map,
          s.snapTargets,
          [e.lngLat.lng, e.lngLat.lat],
          SNAP_PIXELS
        );
        updateSnapIndicator(this.map, snapped);
        if (snapped) e.lngLat = new mapboxgl.LngLat(snapped[0], snapped[1]);
      }
      base.onDrag!.call(this, state, e);
      // Force the vertex exactly onto the snap point (see note above).
      if (snapped && singleVertex && s.feature) {
        try {
          s.feature.updateCoordinate(
            s.selectedCoordPaths![0],
            snapped[0],
            snapped[1]
          );
        } catch {
          /* leave the delta-moved position */
        }
      }
    },
    onMouseUp(state, e) {
      updateSnapIndicator(this.map, null);
      base.onMouseUp?.call(this, state, e);
    },
    onStop(state) {
      updateSnapIndicator(this.map, null);
      base.onStop?.call(this, state);
    },
  };
}
