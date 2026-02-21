import GameMap from "../components/GameMap";
import { zones } from "../lib/zones";
import { useCurrentZone } from "../hooks/useCurrentZone";

export default function MapPage() {
  const { currentZone, playerPosition, error } = useCurrentZone();

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <GameMap zones={zones} />

      {/* Zone indicator — shows which district you're in */}
      <div style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(10, 10, 10, 0.9)',
        border: '1px solid #222',
        borderRadius: 12,
        padding: '12px 20px',
        zIndex: 9999,
        textAlign: 'center',
        fontFamily: 'sans-serif',
      }}>
        {error ? (
          <p style={{ color: '#EF476F', margin: 0, fontSize: '0.85rem' }}>
            GPS: {error}
          </p>
        ) : !playerPosition ? (
          <p style={{ color: '#888', margin: 0, fontSize: '0.85rem' }}>
            Getting your location...
          </p>
        ) : currentZone ? (
          <div>
            <p style={{ color: '#06D6A0', margin: 0, fontSize: '0.8rem', fontWeight: 700 }}>
              YOU ARE IN
            </p>
            <p style={{ color: '#fff', margin: '4px 0 0', fontSize: '1.1rem', fontWeight: 700 }}>
              {currentZone.name}
            </p>
          </div>
        ) : (
          <p style={{ color: '#FFD166', margin: 0, fontSize: '0.85rem' }}>
            Outside game zones
          </p>
        )}
      </div>
    </div>
  );
}