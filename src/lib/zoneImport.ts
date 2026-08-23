// =============================================================================
// Zone Rush — GeoJSON → zone import parser
//
// Turns an uploaded GeoJSON (FeatureCollection / Feature / bare geometry) into
// ParsedZone records, reading names, codes, tags, transit and difficulty from
// feature properties with tolerant key matching. Pure; no Firestore or React.
// =============================================================================

import center from "@turf/center";

export interface ParsedZone {
  name: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  center_lat: number;
  center_lng: number;
  district_number?: number;
  nta_code?: string;
  culture_tags: string[];
  transit_lines: string[];
  landmarks: string[];
  difficulty_rating: number;
}

// Read a tag list from feature properties as a string array (accepts an array
// or a comma/semicolon-separated string). Zones store these as arrays.
function readTagArray(props: Record<string, unknown>, keys: string[]): string[] {
  for (const k of keys) {
    const v = props?.[k];
    if (Array.isArray(v)) {
      return v.map((x) => String(x).trim()).filter(Boolean);
    }
    if (typeof v === "string" && v.trim()) {
      return v
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

// Numeric difficulty_rating (1–5) from properties; default 3.
function readDifficultyRating(props: Record<string, unknown>): number {
  const v = props?.difficulty_rating ?? props?.difficulty;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3;
}

// Keys that hold an identifier rather than a human-readable label.
const CODEISH_KEY = /code|abbr|fips|gid|objectid|(^|_)id($|_)/i;

// Pick the property holding the display name, by ranked preference rather than
// first-match. Code-ish keys are rejected outright: an NYC NTA file has BOTH
// NTACode and NTAName, and a loose first-match would grab the code ("BK37").
function pickNameKey(keys: string[]): string | undefined {
  const candidates = keys.filter((k) => !CODEISH_KEY.test(k));
  const ranked = [
    /^(nta)?_?name$/i, // name, ntaname, nta_name
    /name/i, // NTAName, neighborhood_name, …
    /^(label|title)$/i,
    /label|title/i,
    /neighbou?rhood|hood/i,
  ];
  for (const re of ranked) {
    const hit = candidates.find((k) => re.test(k));
    if (hit) return hit;
  }
  return undefined;
}

// Pick the property holding a zone code (e.g. NTACode), stored as nta_code so
// the code is preserved without hijacking the name.
function pickCodeKey(keys: string[]): string | undefined {
  return (
    keys.find((k) => /^(nta)?_?code$/i.test(k)) ||
    keys.find((k) => /code/i.test(k))
  );
}

// Turn an uploaded GeoJSON of neighborhoods/districts into zone drafts. One
// polygon feature = one zone. Detects a name and district-number property the
// same way Zone Manager does. Used to build a whole new map from a file.
export function parseZonesFromGeojson(geojson: unknown): ParsedZone[] {
  const g = geojson as {
    type?: string;
    features?: { properties?: Record<string, unknown>; geometry?: GeoJSON.Geometry }[];
    geometry?: GeoJSON.Geometry;
    properties?: Record<string, unknown>;
  };
  const features =
    g?.type === "FeatureCollection" && Array.isArray(g.features)
      ? g.features
      : g?.type === "Feature"
      ? [g]
      : g?.type === "Polygon" || g?.type === "MultiPolygon"
      ? [{ properties: {}, geometry: g as GeoJSON.Geometry }]
      : [];
  if (features.length === 0) return [];

  const keys = Object.keys(features[0]?.properties || {});
  const districtKey = keys.find((k) => /dist|district|ward|number|coun/i.test(k));
  const nameKey = pickNameKey(keys);
  const codeKey = pickCodeKey(keys);

  const out: ParsedZone[] = [];
  features.forEach((feat, i) => {
    const geom = feat?.geometry;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) return;
    const props = feat.properties || {};
    const num = districtKey ? parseInt(String(props[districtKey])) : NaN;
    const nameVal = nameKey ? String(props[nameKey] ?? "").trim() : "";
    const codeVal = codeKey ? String(props[codeKey] ?? "").trim() : "";
    const name =
      nameVal ||
      (!isNaN(num) ? `District ${num}` : "") ||
      codeVal ||
      `Zone ${i + 1}`;
    let center_lat = 0;
    let center_lng = 0;
    try {
      const c = center({ type: "Feature", properties: {}, geometry: geom });
      center_lng = Math.round(c.geometry.coordinates[0] * 1e6) / 1e6;
      center_lat = Math.round(c.geometry.coordinates[1] * 1e6) / 1e6;
    } catch {
      /* leave 0,0 */
    }
    out.push({
      name,
      geometry: geom,
      center_lat,
      center_lng,
      culture_tags: readTagArray(props, [
        "culture_tags",
        "cultureTags",
        "culture",
        "tags",
      ]),
      transit_lines: readTagArray(props, [
        "transit_lines",
        "transitLines",
        "transit",
        "subway_lines",
        "lines",
      ]),
      landmarks: readTagArray(props, ["landmarks", "landmark"]),
      difficulty_rating: readDifficultyRating(props),
      ...(isNaN(num) ? {} : { district_number: num }),
      ...(codeVal ? { nta_code: codeVal } : {}),
    });
  });
  return out;
}
