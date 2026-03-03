import { useState, useEffect } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../lib/firebase";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point, polygon } from "@turf/helpers";

export function useCurrentZone() {
  const [zones, setZones] = useState<any[]>([]);
  const [currentZone, setCurrentZone] = useState<any | null>(null);
  const [playerPosition, setPlayerPosition] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load zones from Firestore once
  useEffect(() => {
    async function loadZones() {
      const snapshot = await getDocs(collection(db, "zones"));
      const loaded = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          ...data,
          boundary:
            typeof data.boundary === "string"
              ? JSON.parse(data.boundary)
              : data.boundary,
        };
      });
      setZones(loaded);
    }
    loadZones();
  }, []);

  // GPS tracking
  useEffect(() => {
    if (!navigator.geolocation) {
      setError("Geolocation not supported");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setPlayerPosition({ lat, lng });

        if (zones.length === 0) return;

        const playerPoint = point([lng, lat]);
        const found = zones.find((zone) => {
          try {
            const poly = polygon(zone.boundary.coordinates);
            return booleanPointInPolygon(playerPoint, poly);
          } catch {
            return false;
          }
        });

        setCurrentZone(found || null);
      },
      (err) => {
        setError(err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 15000,
      }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [zones]);

  return { currentZone, playerPosition, error };
}