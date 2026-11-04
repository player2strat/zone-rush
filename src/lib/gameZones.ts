// =============================================================================
// Foray — per-game zone snapshot
//
// When a game is created, every zone it uses is copied into
// games/{gameId}/zones/{zoneId}. Gameplay and results pages read THAT copy, so
// a game's map is frozen at creation: later edits, merges, splits or deletion
// of the library zone can't change (or break) a game's history.
//
// Games created before this existed have no snapshot; loadGameZones falls
// back to the global `zones` collection for them (old behavior).
// =============================================================================

import {
  collection, doc, documentId, getDocs, query, where,
  type WriteBatch,
} from 'firebase/firestore'
import { db } from './firebase'

/** A zone as pages consume it: the stored doc with `boundary` parsed to GeoJSON. */
export interface GameZone {
  id: string
  name: string
  boundary: GeoJSON.Geometry | null
  center_lat?: number
  center_lng?: number
  [key: string]: unknown
}

function parseZoneDoc(id: string, data: Record<string, unknown>): GameZone {
  let boundary: GeoJSON.Geometry | null = null
  try {
    boundary = typeof data.boundary === 'string'
      ? JSON.parse(data.boundary)
      : (data.boundary as GeoJSON.Geometry | null) ?? null
  } catch {
    boundary = null
  }
  return { ...data, id, name: (data.name as string) ?? id, boundary }
}

/**
 * Zones for a game. Prefers the game's own snapshot; falls back to the global
 * library (all zones) for legacy games without one. Callers that filter by
 * `game.zones` keep working either way.
 */
export async function loadGameZones(gameId: string): Promise<GameZone[]> {
  const snap = await getDocs(collection(db, 'games', gameId, 'zones'))
  if (!snap.empty) {
    return snap.docs.map((d) => parseZoneDoc(d.id, d.data()))
  }
  const all = await getDocs(collection(db, 'zones'))
  return all.docs.map((d) => parseZoneDoc(d.id, d.data()))
}

/** Same as loadGameZones but returns a lookup map by zone id. */
export async function loadGameZoneMap(gameId: string): Promise<Map<string, GameZone>> {
  const zones = await loadGameZones(gameId)
  return new Map(zones.map((z) => [z.id, z]))
}

// Firestore's limit on ids in one "in" query.
const IN_QUERY_MAX = 30

/**
 * Copy the given library zones into games/{gameId}/zones on the provided
 * batch (the caller commits). Reads the zone docs fresh so the snapshot
 * matches the library at the moment of creation, 30 to a query rather than
 * one read per zone (an All NYC game has hundreds). Skips ids that don't
 * exist.
 */
export async function snapshotZonesIntoBatch(
  batch: WriteBatch,
  gameId: string,
  zoneIds: string[]
): Promise<number> {
  const ids = [...new Set(zoneIds)]
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += IN_QUERY_MAX) chunks.push(ids.slice(i, i + IN_QUERY_MAX))
  const snaps = await Promise.all(
    chunks.map((chunk) => getDocs(query(collection(db, 'zones'), where(documentId(), 'in', chunk))))
  )
  let n = 0
  for (const snap of snaps) {
    for (const d of snap.docs) {
      batch.set(doc(db, 'games', gameId, 'zones', d.id), {
        ...d.data(),
        id: d.id,
        snapshot_of: d.id,
      })
      n++
    }
  }
  return n
}
