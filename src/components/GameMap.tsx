import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

interface Zone {
  id: string;
  district_number: number;
  name: string;
  city: string;
  boundary: { type: string; coordinates: number[][][]; };
  center_lat: number;
  center_lng: number;
  culture_tags: string[];
  transit_lines: string[];
  landmarks: string[];
  difficulty_rating: number;
}

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const ZONE_COLORS: Record<string, string> = {
  zone_district_33: "#06D6A0",
  zone_district_34: "#FFD166",
  zone_district_35: "#118AB2",
  zone_district_36: "#EF476F",
};

interface GameMapProps {
  zones: Zone[];
}

export default function GameMap({ zones }: GameMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-73.95, 40.70],
      zoom: 12,
    });

    map.current.on("load", () => {
      if (!map.current) return;

      zones.forEach((zone) => {
        const color = ZONE_COLORS[zone.id] || "#ffffff";

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
            "fill-opacity": 0.2,
          },
        });

        map.current!.addLayer({
          id: `zone-border-${zone.id}`,
          type: "line",
          source: `zone-${zone.id}`,
          paint: {
            "line-color": color,
            "line-width": 2,
          },
        });

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
            "text-size": 14,
            "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          },
          paint: {
            "text-color": color,
            "text-halo-color": "#000000",
            "text-halo-width": 1,
          },
        });
      });

      map.current!.addControl(
        new mapboxgl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserHeading: true,
        })
      );
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  return (
    <div
      ref={mapContainer}
      style={{ width: "100%", height: "100vh" }}
    />
  );
}