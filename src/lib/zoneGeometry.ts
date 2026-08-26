// =============================================================================
// Foray — zone geometry helpers (pure functions, no React / Mapbox)
//
// Shared polygon math used by the Zone Builder: overlap detection, coverage
// gap, polygon-by-line split, adjacency, and GeoJSON parsing. Kept separate so
// they can be unit-tested and reused without pulling in the editor UI.
// =============================================================================

import bbox from "@turf/bbox";
import intersect from "@turf/intersect";
import union from "@turf/union";
import difference from "@turf/difference";
import area from "@turf/area";
import type { Zone } from "../types/game";

// Overlap smaller than this (square meters) is treated as a drawing-imprecision
// sliver along a shared border, not a real double-covered area, and is ignored.
export const OVERLAP_TOLERANCE_SQM = 50;

export interface Overlap {
  id: string;
  name: string;
  areaSqM: number;
}

// Real (non-sliver) overlaps between a candidate polygon and each saved zone.
// A shared border is a line (zero area) and won't register; only genuine
// double-covered area above the tolerance is reported.
export function computeOverlaps(
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
export function computeGap(
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

// Cut a polygon with a polyline. Builds a "half-plane" polygon on one side of
// the (far-extended) line, then A = zone ∩ side, B = zone − A. Returns null
// unless both pieces are real (bigger than a sliver).
export function splitPolygonByLine(
  zoneGeom: GeoJSON.Geometry,
  line: GeoJSON.LineString
): {
  a: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  b: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
} | null {
  const zf = toPolyFeature(zoneGeom);
  const pts = line.coordinates.map((c) => [c[0], c[1]] as [number, number]);
  if (!zf || pts.length < 2) return null;

  const [minX, minY, maxX, maxY] = bbox(zf);
  const size = Math.max(maxX - minX, maxY - minY) || 0.001;
  const far = size * 100;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Extend the first and last segments far beyond the zone.
  const extend = (from: [number, number], to: [number, number]): [number, number] => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const L = Math.hypot(dx, dy) || 1;
    return [to[0] + (dx / L) * far, to[1] + (dy / L) * far];
  };
  const p0 = extend(pts[1], pts[0]);
  const pn = extend(pts[pts.length - 2], pts[pts.length - 1]);
  const path: [number, number][] = [p0, ...pts, pn];

  // Close the path with a far point perpendicular to the chord p0→pn, on
  // whichever side is farther from the zone so the closing edges stay clear.
  const mx = (p0[0] + pn[0]) / 2;
  const my = (p0[1] + pn[1]) / 2;
  const chx = pn[0] - p0[0];
  const chy = pn[1] - p0[1];
  const cl = Math.hypot(chx, chy) || 1;
  const nx = -chy / cl;
  const ny = chx / cl;
  const f1: [number, number] = [mx + nx * far, my + ny * far];
  const f2: [number, number] = [mx - nx * far, my - ny * far];
  const d1 = Math.hypot(f1[0] - cx, f1[1] - cy);
  const d2 = Math.hypot(f2[0] - cx, f2[1] - cy);
  const F = d1 >= d2 ? f1 : f2;
  const ring: [number, number][] = [...path, F, p0];
  const side: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };

  let a: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  let b: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  try {
    a = intersect({ type: "FeatureCollection", features: [zf, side] });
    if (!a) return null;
    b = difference({ type: "FeatureCollection", features: [zf, a] });
  } catch {
    return null;
  }
  if (!a || !b) return null;
  if (area(a) < OVERLAP_TOLERANCE_SQM || area(b) < OVERLAP_TOLERANCE_SQM) return null;
  return {
    a: { type: "Feature", properties: {}, geometry: a.geometry },
    b: { type: "Feature", properties: {}, geometry: b.geometry },
  };
}

// True when two polygons share a border (or overlap): their union has fewer
// parts than the two of them laid side by side. Cheap and dependency-free.
export function touches(a: GeoJSON.Geometry, b: GeoJSON.Geometry): boolean {
  const fa = toPolyFeature(a);
  const fb = toPolyFeature(b);
  if (!fa || !fb) return false;
  const parts = (g: GeoJSON.Polygon | GeoJSON.MultiPolygon) =>
    g.type === "Polygon" ? 1 : g.coordinates.length;
  try {
    const u = union({ type: "FeatureCollection", features: [fa, fb] });
    if (!u) return false;
    return parts(u.geometry) < parts(fa.geometry) + parts(fb.geometry);
  } catch {
    return false;
  }
}

// Narrow a geometry to a Polygon/MultiPolygon feature (what the turf ops want).
export function toPolyFeature(
  geom: GeoJSON.Geometry
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") return null;
  return { type: "Feature", properties: {}, geometry: geom };
}

// Zone/map boundaries are stored as JSON strings (sometimes already-parsed
// objects on freshly-written docs). Return a usable geometry or null.
export function parseGeometry(raw: unknown): GeoJSON.Geometry | null {
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
export function extractBoundaryGeometry(
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

