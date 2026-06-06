// =============================================================================
// Seed Manhattan Zones + Map Sets
// Admin page: /admin/seed-maps
// Seeds 12 Manhattan neighborhood zones and 2 map_sets
// =============================================================================

import { useState } from 'react'
import { doc, setDoc, collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'

// ---------------------------------------------------------------------------
// Manhattan zone data (NTA boundaries from NYC Dept of City Planning)
// ---------------------------------------------------------------------------
const MANHATTAN_ZONES = [
  {
    id: 'zone_mn_mn25',
    nta_code: 'MN25',
    name: 'Lower Manhattan',
    full_name: 'Battery Park City-Lower Manhattan',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.708321,
    center_lng: -74.007323,
    culture_tags: ["financial", "waterfront", "historic"],
    transit_lines: ["1", "R", "W", "4", "5"],
    landmarks: ["Wall Street", "Battery Park", "One World Trade", "Staten Island Ferry"],
    difficulty_rating: 2,
    boundary: {"type": "MultiPolygon", "coordinates": [[[[-73.996699, 40.700885], [-73.99514, 40.702982], [-73.996194, 40.703385], [-73.99814, 40.701527], [-73.996699, 40.700885]]], [[[-74.006136, 40.711956], [-74.008602, 40.7114], [-74.013843, 40.713737], [-74.012443, 40.719066], [-74.013032, 40.71914], [-74.013215, 40.718324], [-74.016712, 40.718632], [-74.017802, 40.712353], [-74.019343, 40.706079], [-74.017572, 40.704192], [-74.014291, 40.704557], [-74.013953, 40.700999], [-74.01111, 40.70091], [-74.003325, 40.705637], [-74.001439, 40.70488], [-74.001188, 40.706868], [-73.999196, 40.707956], [-74.003533, 40.7114], [-74.006136, 40.711956]]]]},
  },
  {
    id: 'zone_mn_mn28',
    nta_code: 'MN28',
    name: 'Lower East Side',
    full_name: 'Lower East Side',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.715735,
    center_lng: -73.983589,
    culture_tags: ["jewish", "latin", "nightlife", "art"],
    transit_lines: ["F", "M", "J", "Z"],
    landmarks: ["Essex Market", "Tenement Museum", "Katz's Deli", "Sara D. Roosevelt Park"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.991907, 40.709534], [-73.988638, 40.70992], [-73.988166, 40.709165], [-73.981247, 40.709834], [-73.978257, 40.710506], [-73.97643, 40.711917], [-73.974902, 40.715142], [-73.973114, 40.720167], [-73.971628, 40.726637], [-73.978028, 40.729441], [-73.983825, 40.721481], [-73.985075, 40.719092], [-73.986753, 40.719601], [-73.988368, 40.716454], [-73.990204, 40.714673], [-73.992564, 40.714396], [-73.991907, 40.709534]]]},
  },
  {
    id: 'zone_mn_mn27',
    nta_code: 'MN27',
    name: 'Chinatown',
    full_name: 'Chinatown',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.715767,
    center_lng: -73.993813,
    culture_tags: ["chinese", "food", "markets", "historic"],
    transit_lines: ["N", "Q", "R", "W", "6", "B", "D"],
    landmarks: ["Canal Street", "Columbus Park", "Manhattan Bridge", "Doyers Street"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.983825, 40.721481], [-73.992605, 40.724145], [-73.994809, 40.718466], [-73.99606, 40.71624], [-73.999958, 40.718025], [-74.002724, 40.714398], [-74.006136, 40.711956], [-74.003533, 40.7114], [-73.999196, 40.707956], [-73.997284, 40.70874], [-73.991907, 40.709534], [-73.992564, 40.714396], [-73.990204, 40.714673], [-73.988368, 40.716454], [-73.986753, 40.719601], [-73.985075, 40.719092], [-73.983825, 40.721481]]]},
  },
  {
    id: 'zone_mn_mn24',
    nta_code: 'MN24',
    name: 'SoHo-TriBeCa',
    full_name: 'SoHo-TriBeCa-Civic Center-Little Italy',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.72015,
    center_lng: -74.003687,
    culture_tags: ["art", "fashion", "galleries", "architecture"],
    transit_lines: ["C", "E", "6", "N", "R", "W", "1"],
    landmarks: ["Broadway", "Fanelli Cafe", "Washington Market Park", "Cast Iron Historic District"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.992605, 40.724145], [-73.997612, 40.725805], [-74.002819, 40.728371], [-74.010675, 40.729121], [-74.011385, 40.728238], [-74.013032, 40.71914], [-74.012443, 40.719066], [-74.013843, 40.713737], [-74.008602, 40.7114], [-74.006136, 40.711956], [-74.002724, 40.714398], [-73.999958, 40.718025], [-73.99606, 40.71624], [-73.994809, 40.718466], [-73.992605, 40.724145]]]},
  },
  {
    id: 'zone_mn_mn22',
    nta_code: 'MN22',
    name: 'East Village',
    full_name: 'East Village',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.72857,
    center_lng: -73.985825,
    culture_tags: ["punk", "counterculture", "food", "nightlife"],
    transit_lines: ["L", "6", "N", "R", "W"],
    landmarks: ["Tompkins Square Park", "St Marks Place", "Astor Place", "Alphabet City"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.982558, 40.731358], [-73.989904, 40.734443], [-73.991299, 40.727764], [-73.992605, 40.724145], [-73.983825, 40.721481], [-73.978028, 40.729441], [-73.982558, 40.731358]]]},
  },
  {
    id: 'zone_mn_mn23',
    nta_code: 'MN23',
    name: 'West Village',
    full_name: 'West Village',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.731852,
    center_lng: -74.00386,
    culture_tags: ["lgbtq", "jazz", "brownstone", "bohemian"],
    transit_lines: ["1", "2", "3", "A", "C", "E", "L"],
    landmarks: ["Washington Square Park", "Stonewall Inn", "Bleecker Street", "The High Line South"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.989904, 40.734443], [-74.0087, 40.74237], [-74.009168, 40.742425], [-74.010394, 40.739183], [-74.011163, 40.730459], [-74.014017, 40.730691], [-74.014392, 40.728471], [-74.011385, 40.728238], [-74.010675, 40.729121], [-74.002819, 40.728371], [-73.997612, 40.725805], [-73.992605, 40.724145], [-73.991299, 40.727764], [-73.989904, 40.734443]]]},
  },
  {
    id: 'zone_mn_mn21',
    nta_code: 'MN21',
    name: 'Gramercy',
    full_name: 'Gramercy',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.737488,
    center_lng: -73.982787,
    culture_tags: ["residential", "historic", "parks"],
    transit_lines: ["6", "L", "N", "R", "W"],
    landmarks: ["Gramercy Park", "Irving Plaza", "Pete's Tavern", "Stuyvesant Square"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.978542, 40.736896], [-73.978054, 40.737562], [-73.982669, 40.739507], [-73.980861, 40.741978], [-73.984076, 40.743333], [-73.989876, 40.735417], [-73.989904, 40.734443], [-73.982558, 40.731358], [-73.978542, 40.736896]]]},
  },
  {
    id: 'zone_mn_mn20',
    nta_code: 'MN20',
    name: 'Murray Hill-Kips Bay',
    full_name: 'Murray Hill-Kips Bay',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.7434,
    center_lng: -73.977173,
    culture_tags: ["south_asian", "residential", "food"],
    transit_lines: ["6", "S", "7"],
    landmarks: ["Curry Hill", "Morgan Library", "Grand Central area", "Kips Bay Plaza"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.974442, 40.735325], [-73.972491, 40.735812], [-73.972659, 40.739231], [-73.971681, 40.743063], [-73.97351, 40.74379], [-73.97123, 40.746927], [-73.975843, 40.748894], [-73.974446, 40.750773], [-73.97835, 40.752418], [-73.980889, 40.753489], [-73.984078, 40.74911], [-73.980852, 40.747759], [-73.984076, 40.743333], [-73.980861, 40.741978], [-73.982669, 40.739507], [-73.978054, 40.737562], [-73.978542, 40.736896], [-73.974442, 40.735325]]]},
  },
  {
    id: 'zone_mn_mn13',
    nta_code: 'MN13',
    name: 'Chelsea-Flatiron',
    full_name: 'Hudson Yards-Chelsea-Flatiron-Union Square',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.750122,
    center_lng: -73.999413,
    culture_tags: ["art", "galleries", "food", "tech"],
    transit_lines: ["1", "2", "3", "F", "M", "L", "N", "R", "W"],
    landmarks: ["Chelsea Market", "High Line", "Flatiron Building", "Madison Square Park", "Union Square"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-74.001535, 40.762653], [-74.003135, 40.761087], [-74.007621, 40.75429], [-74.00995, 40.74894], [-74.00906, 40.747794], [-74.00956, 40.745297], [-74.009168, 40.742425], [-74.0087, 40.74237], [-73.989904, 40.734443], [-73.989876, 40.735417], [-73.984076, 40.743333], [-73.990516, 40.746049], [-73.99142, 40.744811], [-73.9971, 40.747213], [-73.991634, 40.754715], [-73.9973, 40.757115], [-73.995476, 40.759635], [-74.001279, 40.762084], [-74.001535, 40.762653]]]},
  },
  {
    id: 'zone_mn_mn19',
    nta_code: 'MN19',
    name: 'Turtle Bay-East Midtown',
    full_name: 'Turtle Bay-East Midtown',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.751452,
    center_lng: -73.971087,
    culture_tags: ["diplomatic", "corporate", "historic"],
    transit_lines: ["4", "5", "6", "7", "S", "E", "M"],
    landmarks: ["United Nations", "Chrysler Building", "Tudor City", "Grand Central"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.971681, 40.743063], [-73.965325, 40.751056], [-73.958779, 40.758279], [-73.966585, 40.761559], [-73.969802, 40.762922], [-73.975809, 40.754686], [-73.97835, 40.752418], [-73.974446, 40.750773], [-73.975843, 40.748894], [-73.97123, 40.746927], [-73.97351, 40.74379], [-73.971681, 40.743063]]]},
  },
  {
    id: 'zone_mn_mn17',
    nta_code: 'MN17',
    name: 'Midtown',
    full_name: 'Midtown-Midtown South',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.754691,
    center_lng: -73.982295,
    culture_tags: ["theater", "tourist", "commercial", "iconic"],
    transit_lines: ["1", "2", "3", "7", "N", "Q", "R", "W", "B", "D", "F", "M", "S"],
    landmarks: ["Times Square", "Bryant Park", "Rockefeller Center", "Grand Central Terminal"],
    difficulty_rating: 3,
    boundary: {"type": "Polygon", "coordinates": [[[-73.973016, 40.764287], [-73.981493, 40.767889], [-73.982367, 40.7674], [-73.991634, 40.754715], [-73.9971, 40.747213], [-73.99142, 40.744811], [-73.990516, 40.746049], [-73.984076, 40.743333], [-73.980852, 40.747759], [-73.984078, 40.74911], [-73.980889, 40.753489], [-73.97835, 40.752418], [-73.975809, 40.754686], [-73.969802, 40.762922], [-73.973016, 40.764287]]]},
  },
  {
    id: 'zone_mn_mn15',
    nta_code: 'MN15',
    name: 'Hells Kitchen',
    full_name: 'Clinton',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.76529,
    center_lng: -73.995276,
    culture_tags: ["theater", "food", "diverse", "waterfront"],
    transit_lines: ["A", "C", "E", "1", "2", "3", "7", "N", "Q", "R", "W"],
    landmarks: ["Restaurant Row", "Hudson Yards", "Intrepid Museum", "DeWitt Clinton Park"],
    difficulty_rating: 2,
    boundary: {"type": "Polygon", "coordinates": [[[-73.993833, 40.77294], [-73.996573, 40.769433], [-73.996459, 40.768107], [-73.999152, 40.764214], [-74.001535, 40.762653], [-74.001279, 40.762084], [-73.995476, 40.759635], [-73.9973, 40.757115], [-73.991634, 40.754715], [-73.982367, 40.7674], [-73.993876, 40.772246], [-73.993833, 40.77294]]]},
  }
]

// ---------------------------------------------------------------------------
// Map set definitions
// ---------------------------------------------------------------------------
const MAP_SETS = [
  {
    id: 'brooklyn_alpha_d33_36',
    name: 'Brooklyn Alpha (D33\u201336)',
    description: 'Original alpha test map \u2014 Brooklyn City Council Districts 33, 34, 35, 36.',
    city: 'nyc',
    borough: 'Brooklyn',
    zone_ids: [] as string[], // auto-populated from existing Brooklyn zones
    map_center: { lat: 40.6782, lng: -73.9442, zoom: 12 },
    is_active: true,
    recommended_teams: 3,
    recommended_duration: 180,
    created_at: new Date(),
  },
  {
    id: 'manhattan_neighborhoods',
    name: 'Manhattan Neighborhoods',
    description: '12 walkable neighborhoods from Lower Manhattan to Hell\'s Kitchen. Transit-rich, culturally distinct.',
    city: 'nyc',
    borough: 'Manhattan',
    zone_ids: ["zone_mn_mn25", "zone_mn_mn28", "zone_mn_mn27", "zone_mn_mn24", "zone_mn_mn22", "zone_mn_mn23", "zone_mn_mn21", "zone_mn_mn20", "zone_mn_mn13", "zone_mn_mn19", "zone_mn_mn17", "zone_mn_mn15"],
    map_center: { lat: 40.7380, lng: -73.9900, zoom: 13 },
    is_active: true,
    recommended_teams: 5,
    recommended_duration: 180,
    created_at: new Date(),
  },
]

export default function SeedMaps() {
  const [status, setStatus] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  const log = (msg: string) => setStatus((prev) => [...prev, msg])

  const seedManhattanZones = async () => {
    log('--- Seeding Manhattan zones ---')
    let created = 0
    for (const zone of MANHATTAN_ZONES) {
      try {
        await setDoc(doc(db, 'zones', zone.id), {
          id: zone.id,
          nta_code: zone.nta_code,
          name: zone.name,
          full_name: zone.full_name,
          borough: zone.borough,
          city: zone.city,
          center_lat: zone.center_lat,
          center_lng: zone.center_lng,
          culture_tags: zone.culture_tags,
          transit_lines: zone.transit_lines,
          landmarks: zone.landmarks,
          difficulty_rating: zone.difficulty_rating,
          boundary: zone.boundary,
        }, { merge: true })
        created++
        log(`  \u2713 ${zone.name} (${zone.id})`)
      } catch (err: any) {
        log(`  \u2717 ${zone.name} \u2014 ${err.message}`)
      }
    }
    log(`Manhattan zones: ${created} written`)
  }

  const seedMapSets = async () => {
    log('--- Seeding map_sets ---')

    const zonesSnap = await getDocs(
      query(collection(db, 'zones'), where('city', '==', 'nyc'))
    )
    const brooklynZoneIds: string[] = []
    zonesSnap.forEach((d) => {
      const data = d.data()
      if (data.borough === 'Brooklyn' || (!data.borough && !d.id.startsWith('zone_mn_'))) {
        brooklynZoneIds.push(d.id)
      }
    })

    for (const mapSet of MAP_SETS) {
      try {
        const zoneIds =
          mapSet.id === 'brooklyn_alpha_d33_36'
            ? brooklynZoneIds
            : mapSet.zone_ids

        await setDoc(doc(db, 'map_sets', mapSet.id), {
          ...mapSet,
          zone_ids: zoneIds,
        })
        log(`  \u2713 ${mapSet.name} (${zoneIds.length} zones)`)
      } catch (err: any) {
        log(`  \u2717 ${mapSet.name} \u2014 ${err.message}`)
      }
    }
    log('Map sets seeded.')
  }

  const addBoroughToExistingZones = async () => {
    log('--- Adding borough field to existing Brooklyn zones ---')
    const snap = await getDocs(
      query(collection(db, 'zones'), where('city', '==', 'nyc'))
    )
    const promises: Promise<void>[] = []
    snap.forEach((d) => {
      const data = d.data()
      if (d.id.startsWith('zone_mn_')) return
      if (!data.borough) {
        promises.push(
          setDoc(doc(db, 'zones', d.id), { borough: 'Brooklyn' }, { merge: true })
            .then(() => log(`  \u2713 ${d.id} \u2192 borough: Brooklyn`))
        )
      }
    })
    await Promise.all(promises)
    log(`Updated ${promises.length} existing zones with borough field.`)
  }

  const runAll = async () => {
    setRunning(true)
    setStatus([])
    log('Starting seed...')
    await addBoroughToExistingZones()
    await seedManhattanZones()
    await seedMapSets()
    log('')
    log('\u2705 All done! Manhattan zones and map_sets are live.')
    setRunning(false)
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', sans-serif",
      padding: '32px 24px',
    }}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: 4 }}>
          Seed Maps & Zones
        </h1>
        <p style={{ color: '#666', fontSize: '0.85rem', marginBottom: 24 }}>
          Seeds 12 Manhattan neighborhood zones + 2 map_sets (Brooklyn Alpha, Manhattan)
        </p>

        <div style={{
          background: 'rgba(255,209,102,0.06)',
          border: '1px solid rgba(255,209,102,0.2)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 24,
        }}>
          <p style={{ color: '#FFD166', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            This will:
          </p>
          {[
            'Add borough: "Brooklyn" to existing zone docs (if missing)',
            'Create 12 Manhattan neighborhood zone documents in Firestore',
            'Create "Brooklyn Alpha (D33\u201336)" map_set (auto-detects existing Brooklyn zones)',
            'Create "Manhattan Neighborhoods" map_set (12 zones)',
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <span style={{ color: '#FFD166' }}>{i + 1}.</span>
              <span style={{ color: '#ccc', fontSize: '0.88rem' }}>{item}</span>
            </div>
          ))}
        </div>

        <button
          onClick={runAll}
          disabled={running}
          style={{
            width: '100%',
            background: running ? '#1a1a1a' : 'rgba(6,214,160,0.12)',
            border: `1px solid ${running ? '#222' : 'rgba(6,214,160,0.3)'}`,
            color: running ? '#444' : '#06D6A0',
            padding: '16px 24px',
            borderRadius: 12,
            fontSize: '1rem',
            fontWeight: 700,
            cursor: running ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            marginBottom: 20,
          }}
        >
          {running ? 'Seeding...' : '\uD83C\uDF31 Seed Manhattan Zones + Map Sets'}
        </button>

        {status.length > 0 && (
          <div style={{
            background: '#0d0d0d',
            border: '1px solid #1e1e1e',
            borderRadius: 10,
            padding: 16,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.78rem',
            lineHeight: 1.8,
            maxHeight: 400,
            overflowY: 'auto',
          }}>
            {status.map((line, i) => (
              <div key={i} style={{
                color: line.includes('\u2713') ? '#06D6A0'
                  : line.includes('\u2717') ? '#EF476F'
                  : line.includes('\u2705') ? '#06D6A0'
                  : line.startsWith('---') ? '#FFD166'
                  : '#888',
              }}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}