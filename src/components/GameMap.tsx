// =============================================================================
// Zone Rush — Game Map (Day 11)
// Mapbox map with zone polygons, ownership coloring, and compact mode
//
// CHANGES FROM DAY 10:
// - NEW: zoneOwnership prop — colors zones with the owning team's color
// - NEW: compact prop — smaller, non-interactive version for GM dashboard
// - NEW: applyOwnership() — dynamically updates paint properties on ownership change
// - CHANGED: default fill-opacity lowered to 0.15 (claimed zones boost to 0.45)
// =============================================================================

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

// --------------- Types ---------------

interface Zone {
  id: string;
  district_number: number;
  name: string;
  city: string;
  boundary: { type: string; coordinates: number[][][] };
  center_lat: number;
  center_lng: number;
  culture_tags: string[];
  transit_lines: string[];
  landmarks: string[];
  difficulty_rating: number;
}

export interface ZoneOwner {
  teamColor: string;
  teamName: string;
}

interface GameMapProps {
  zones: Zone[];
  /** Map of zoneId → { teamColor, teamName }. Claimed zones render in team color. */
  zoneOwnership?: Map<string, ZoneOwner>;
  /** Compact mode for the GM dashboard mini map — smaller, non-interactive */
  compact?: boolean;
}

// --------------- Constants ---------------

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

/** Default zone colors when unclaimed */
const ZONE_COLORS: Record<string, string> = {
  zone_district_33: "#06D6A0",
  zone_district_34: "#FFD166",
  zone_district_35: "#118AB2",
  zone_district_36: "#EF476F",
};

// --------------- Component ---------------

export default function GameMap({
  zones,
  zoneOwnership,
  compact = false,
}: GameMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const mapLoaded = useRef(false);

  // ---- Apply ownership colors to map layers ----
  const applyOwnership = (ownership: Map<string, ZoneOwner> | undefined) => {
    if (!map.current || !mapLoaded.current) return;

    zones.forEach((zone) => {
      const owner = ownership?.get(zone.id);
      const defaultColor = ZONE_COLORS[zone.id] || "#ffffff";

      // Claimed zones: team color, higher opacity, thicker border
      const fillColor = owner ? owner.teamColor : defaultColor;
      const fillOpacity = owner ? 0.45 : 0.15;
      const borderColor = owner ? owner.teamColor : defaultColor;
      const borderWidth = owner ? 3 : 2;
      const labelColor = owner ? owner.teamColor : defaultColor;

      try {
        map.current!.setPaintProperty(
          `zone-fill-${zone.id}`,
          "fill-color",
          fillColor
        );
        map.current!.setPaintProperty(
          `zone-fill-${zone.id}`,
          "fill-opacity",
          fillOpacity
        );
        map.current!.setPaintProperty(
          `zone-border-${zone.id}`,
          "line-color",
          borderColor
        );
        map.current!.setPaintProperty(
          `zone-border-${zone.id}`,
          "line-width",
          borderWidth
        );
        map.current!.setPaintProperty(
          `zone-label-${zone.id}`,
          "text-color",
          labelColor
        );
      } catch {
        // Layers may not exist yet during initial load
      }
    });
  };

  // ---- Initialize Mapbox ----
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-73.95, 40.7],
      zoom: compact ? 11.5 : 12,
      interactive: !compact, // GM mini map is view-only
      attributionControl: !compact,
    });

    map.current.on("load", () => {
      if (!map.current) return;
      mapLoaded.current = true;

      // Add zone layers
      zones.forEach((zone) => {
        const color = ZONE_COLORS[zone.id] || "#ffffff";

        // Zone fill polygon
        map.current!.addSource(`zone-${zone.id}`, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: { name: zone.name },
            geometry: zone.boundary as any,
          },
        });

        map.current!.addLayer({
          id: `zone-fill-${zone.id}`,
          type: "fill",
          source: `zone-${zone.id}`,
          paint: {
            "fill-color": color,
            "fill-opacity": 0.15,
          },
        });

        // Zone border
        map.current!.addLayer({
          id: `zone-border-${zone.id}`,
          type: "line",
          source: `zone-${zone.id}`,
          paint: {
            "line-color": color,
            "line-width": 2,
          },
        });

        // Zone label at center point
        map.current!.addSource(`label-${zone.id}`, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: { name: zone.name },
            geometry: {
              type: "Point",
              coordinates: [zone.center_lng, zone.center_lat],
            },
          },
        });

        map.current!.addLayer({
          id: `zone-label-${zone.id}`,
          type: "symbol",
          source: `label-${zone.id}`,
          layout: {
            "text-field": ["get", "name"],
            "text-size": compact ? 11 : 14,
            "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          },
          paint: {
            "text-color": color,
            "text-halo-color": "#000000",
            "text-halo-width": 1,
          },
        });
      });

      // Geolocate control — player map only
      if (!compact) {
        map.current!.addControl(
          new mapboxgl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true },
            trackUserLocation: true,
            showUserHeading: true,
          })
        );
      }

      // Apply ownership colors immediately if data is already available
      applyOwnership(zoneOwnership);
    });

    return () => {
      map.current?.remove();
      map.current = null;
      mapLoaded.current = false;
    };
  }, []);

  // ---- React to ownership changes ----
  useEffect(() => {
    applyOwnership(zoneOwnership);
  }, [zoneOwnership]);

  // ---- Render ----
  return (
    <div
      ref={mapContainer}
      style={{
        width: "100%",
        height: compact ? "100%" : "100vh",
        borderRadius: compact ? 10 : 0,
      }}
    />
  );
}