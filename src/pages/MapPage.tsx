import GameMap from "../components/GameMap";
import { zones } from "../lib/zones";

export default function MapPage() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <GameMap zones={zones} />
    </div>
  );
}