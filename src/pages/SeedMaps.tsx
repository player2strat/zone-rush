// =============================================================================
// Seed Manhattan Zones + Maps (+ map_id migration)
// Admin page: /admin/seed-maps
// Seeds ALL 29 Manhattan zones (28 neighborhoods + Central Park), seeds the
// top-level `maps` collection (replaces `map_sets`), and backfills a required
// `map_id` onto every zone so no zone is shared across maps.
// Safe to re-run — uses merge: true; map_id backfill is first-wins + idempotent.
// =============================================================================

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, setDoc, collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'

// ---------------------------------------------------------------------------
// All 29 Manhattan zones (28 NTA neighborhoods + Central Park)
// NTA boundaries from NYC Dept of City Planning; Central Park is a hand-built
// polygon (the park is a clean rectangle bounded by 59th St, 110th St,
// Fifth Ave, and Central Park West).
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
    boundary: JSON.stringify({"type": "MultiPolygon", "coordinates": [[[[-73.996699, 40.700885], [-73.99514, 40.702982], [-73.996194, 40.703385], [-73.99814, 40.701527], [-73.996699, 40.700885]]], [[[-74.006136, 40.711956], [-74.008602, 40.7114], [-74.013843, 40.713737], [-74.012443, 40.719066], [-74.013032, 40.71914], [-74.013215, 40.718324], [-74.016712, 40.718632], [-74.017802, 40.712353], [-74.019343, 40.706079], [-74.017572, 40.704192], [-74.014291, 40.704557], [-74.013953, 40.700999], [-74.01111, 40.70091], [-74.003325, 40.705637], [-74.001439, 40.70488], [-74.001188, 40.706868], [-73.999196, 40.707956], [-74.003533, 40.7114], [-74.006136, 40.711956]]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.991907, 40.709534], [-73.988638, 40.70992], [-73.988166, 40.709165], [-73.981247, 40.709834], [-73.978257, 40.710506], [-73.97643, 40.711917], [-73.974902, 40.715142], [-73.973114, 40.720167], [-73.971628, 40.726637], [-73.978028, 40.729441], [-73.983825, 40.721481], [-73.985075, 40.719092], [-73.986753, 40.719601], [-73.988368, 40.716454], [-73.990204, 40.714673], [-73.992564, 40.714396], [-73.991907, 40.709534]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.983825, 40.721481], [-73.992605, 40.724145], [-73.994809, 40.718466], [-73.99606, 40.71624], [-73.999958, 40.718025], [-74.002724, 40.714398], [-74.006136, 40.711956], [-74.003533, 40.7114], [-73.999196, 40.707956], [-73.997284, 40.70874], [-73.991907, 40.709534], [-73.992564, 40.714396], [-73.990204, 40.714673], [-73.988368, 40.716454], [-73.986753, 40.719601], [-73.985075, 40.719092], [-73.983825, 40.721481]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.992605, 40.724145], [-73.997612, 40.725805], [-74.002819, 40.728371], [-74.010675, 40.729121], [-74.011385, 40.728238], [-74.013032, 40.71914], [-74.012443, 40.719066], [-74.013843, 40.713737], [-74.008602, 40.7114], [-74.006136, 40.711956], [-74.002724, 40.714398], [-73.999958, 40.718025], [-73.99606, 40.71624], [-73.994809, 40.718466], [-73.992605, 40.724145]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.982558, 40.731358], [-73.989904, 40.734443], [-73.991299, 40.727764], [-73.992605, 40.724145], [-73.983825, 40.721481], [-73.978028, 40.729441], [-73.982558, 40.731358]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.989904, 40.734443], [-74.0087, 40.74237], [-74.009168, 40.742425], [-74.010394, 40.739183], [-74.011163, 40.730459], [-74.014017, 40.730691], [-74.014392, 40.728471], [-74.011385, 40.728238], [-74.010675, 40.729121], [-74.002819, 40.728371], [-73.997612, 40.725805], [-73.992605, 40.724145], [-73.991299, 40.727764], [-73.989904, 40.734443]]]}),
  },
  {
    id: 'zone_mn_mn50',
    nta_code: 'MN50',
    name: 'Stuyvesant Town',
    full_name: 'Stuyvesant Town-Cooper Village',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.731941,
    center_lng: -73.975567,
    culture_tags: ["residential", "planned_community"],
    transit_lines: ["L", "6"],
    landmarks: ["Stuyvesant Town", "Peter Cooper Village", "Stuyvesant Oval"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.974442, 40.735325], [-73.978542, 40.736896], [-73.982558, 40.731358], [-73.978028, 40.729441], [-73.971628, 40.726637], [-73.971481, 40.729258], [-73.973415, 40.731291], [-73.974442, 40.735325]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.978542, 40.736896], [-73.978054, 40.737562], [-73.982669, 40.739507], [-73.980861, 40.741978], [-73.984076, 40.743333], [-73.989876, 40.735417], [-73.989904, 40.734443], [-73.982558, 40.731358], [-73.978542, 40.736896]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.974442, 40.735325], [-73.972491, 40.735812], [-73.972659, 40.739231], [-73.971681, 40.743063], [-73.97351, 40.74379], [-73.97123, 40.746927], [-73.975843, 40.748894], [-73.974446, 40.750773], [-73.97835, 40.752418], [-73.980889, 40.753489], [-73.984078, 40.74911], [-73.980852, 40.747759], [-73.984076, 40.743333], [-73.980861, 40.741978], [-73.982669, 40.739507], [-73.978054, 40.737562], [-73.978542, 40.736896], [-73.974442, 40.735325]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-74.001535, 40.762653], [-74.003135, 40.761087], [-74.007621, 40.75429], [-74.00995, 40.74894], [-74.00906, 40.747794], [-74.00956, 40.745297], [-74.009168, 40.742425], [-74.0087, 40.74237], [-73.989904, 40.734443], [-73.989876, 40.735417], [-73.984076, 40.743333], [-73.990516, 40.746049], [-73.99142, 40.744811], [-73.9971, 40.747213], [-73.991634, 40.754715], [-73.9973, 40.757115], [-73.995476, 40.759635], [-74.001279, 40.762084], [-74.001535, 40.762653]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.971681, 40.743063], [-73.965325, 40.751056], [-73.958779, 40.758279], [-73.966585, 40.761559], [-73.969802, 40.762922], [-73.975809, 40.754686], [-73.97835, 40.752418], [-73.974446, 40.750773], [-73.975843, 40.748894], [-73.97123, 40.746927], [-73.97351, 40.74379], [-73.971681, 40.743063]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.973016, 40.764287], [-73.981493, 40.767889], [-73.982367, 40.7674], [-73.991634, 40.754715], [-73.9971, 40.747213], [-73.99142, 40.744811], [-73.990516, 40.746049], [-73.984076, 40.743333], [-73.980852, 40.747759], [-73.984078, 40.74911], [-73.980889, 40.753489], [-73.97835, 40.752418], [-73.975809, 40.754686], [-73.969802, 40.762922], [-73.973016, 40.764287]]]}),
  },
  {
    id: 'zone_mn_mn31',
    nta_code: 'MN31',
    name: 'Lenox Hill-Roosevelt Island',
    full_name: 'Lenox Hill-Roosevelt Island',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.764015,
    center_lng: -73.951221,
    culture_tags: ["residential", "upscale", "medical", "museums"],
    transit_lines: ["4", "5", "6", "F", "Q"],
    landmarks: ["Lenox Hill Hospital", "Park Avenue", "Roosevelt Island Tram"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "MultiPolygon", "coordinates": [[[[-73.941802, 40.769055], [-73.940202, 40.771137], [-73.942128, 40.772043], [-73.944725, 40.769742], [-73.949088, 40.764272], [-73.953664, 40.759488], [-73.960687, 40.75121], [-73.957916, 40.752118], [-73.952542, 40.757104], [-73.942857, 40.768312], [-73.941802, 40.769055]]], [[[-73.958779, 40.758279], [-73.95442, 40.762192], [-73.947491, 40.770123], [-73.957296, 40.774292], [-73.966585, 40.761559], [-73.958779, 40.758279]]]]}),
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
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.993833, 40.77294], [-73.996573, 40.769433], [-73.996459, 40.768107], [-73.999152, 40.764214], [-74.001535, 40.762653], [-74.001279, 40.762084], [-73.995476, 40.759635], [-73.9973, 40.757115], [-73.991634, 40.754715], [-73.982367, 40.7674], [-73.993876, 40.772246], [-73.993833, 40.77294]]]}),
  },
  {
    id: 'zone_mn_mn40',
    nta_code: 'MN40',
    name: 'Upper East Side-Carnegie Hill',
    full_name: 'Upper East Side-Carnegie Hill',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.774483,
    center_lng: -73.960163,
    culture_tags: ["museums", "upscale", "historic", "cultural"],
    transit_lines: ["4", "5", "6", "Q"],
    landmarks: ["Metropolitan Museum", "Guggenheim", "Museum Mile", "Central Park East"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.949333, 40.785201], [-73.955779, 40.787922], [-73.973016, 40.764287], [-73.969802, 40.762922], [-73.966585, 40.761559], [-73.957296, 40.774292], [-73.949333, 40.785201]]]}),
  },
  {
    id: 'zone_mn_mn14',
    nta_code: 'MN14',
    name: 'Lincoln Square',
    full_name: 'Lincoln Square',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.775395,
    center_lng: -73.985162,
    culture_tags: ["performing_arts", "cultural", "upscale"],
    transit_lines: ["1", "2", "3", "A", "B", "C", "D"],
    landmarks: ["Lincoln Center", "Columbus Circle", "Central Park West", "Juilliard"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.975003, 40.777536], [-73.985073, 40.781788], [-73.985681, 40.780321], [-73.988129, 40.78141], [-73.98887, 40.779701], [-73.990929, 40.777575], [-73.993833, 40.77294], [-73.993876, 40.772246], [-73.982367, 40.7674], [-73.981493, 40.767889], [-73.981681, 40.768398], [-73.975003, 40.777536]]]}),
  },
  {
    id: 'zone_mn_mn32',
    nta_code: 'MN32',
    name: 'Yorkville',
    full_name: 'Yorkville',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.778305,
    center_lng: -73.946219,
    culture_tags: ["german", "czech", "residential", "food"],
    transit_lines: ["4", "5", "6", "Q"],
    landmarks: ["Carl Schurz Park", "Gracie Mansion", "East River Esplanade"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.943546, 40.782889], [-73.949333, 40.785201], [-73.957296, 40.774292], [-73.947491, 40.770123], [-73.942932, 40.774685], [-73.942004, 40.776194], [-73.943602, 40.780167], [-73.943546, 40.782889]]]}),
  },
  {
    id: 'zone_mn_mn12',
    nta_code: 'MN12',
    name: 'Upper West Side',
    full_name: 'Upper West Side',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.789122,
    center_lng: -73.97592,
    culture_tags: ["cultural", "residential", "parks", "food"],
    transit_lines: ["1", "2", "3", "B", "C"],
    landmarks: ["American Museum of Natural History", "Riverside Park", "Zabar's", "Beacon Theatre"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.960032, 40.798046], [-73.972873, 40.803364], [-73.980539, 40.792465], [-73.988129, 40.78141], [-73.985681, 40.780321], [-73.985073, 40.781788], [-73.975003, 40.777536], [-73.960032, 40.798046]]]}),
  },
  {
    id: 'zone_mn_mn33',
    nta_code: 'MN33',
    name: 'East Harlem South',
    full_name: 'East Harlem South',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.790686,
    center_lng: -73.942347,
    culture_tags: ["latin", "puerto_rican", "food", "art"],
    transit_lines: ["6", "Q"],
    landmarks: ["El Museo del Barrio", "La Marqueta", "Marcus Garvey Park"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.935055, 40.791695], [-73.937738, 40.792824], [-73.93865, 40.791566], [-73.943274, 40.793496], [-73.941877, 40.795414], [-73.948313, 40.798137], [-73.949235, 40.79688], [-73.955779, 40.787922], [-73.949333, 40.785201], [-73.943546, 40.782889], [-73.939828, 40.785265], [-73.938117, 40.787193], [-73.937063, 40.789422], [-73.935055, 40.791695]]]}),
  },
  {
    id: 'zone_mn_mn34',
    nta_code: 'MN34',
    name: 'East Harlem North',
    full_name: 'East Harlem North',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.802884,
    center_lng: -73.937364,
    culture_tags: ["latin", "caribbean", "food", "murals"],
    transit_lines: ["4", "5", "6"],
    landmarks: ["Thomas Jefferson Park", "Harlem River Houses"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.935055, 40.791695], [-73.930198, 40.794601], [-73.929038, 40.796771], [-73.929036, 40.801089], [-73.931161, 40.804975], [-73.933563, 40.807609], [-73.93434, 40.80957], [-73.933983, 40.812823], [-73.933831, 40.819499], [-73.934076, 40.817835], [-73.939019, 40.810865], [-73.935809, 40.809506], [-73.938546, 40.805738], [-73.941773, 40.807097], [-73.944303, 40.806399], [-73.946133, 40.803886], [-73.944601, 40.803233], [-73.948313, 40.798137], [-73.941877, 40.795414], [-73.943274, 40.793496], [-73.93865, 40.791566], [-73.937738, 40.792824], [-73.935055, 40.791695]]]}),
  },
  {
    id: 'zone_mn_mn11',
    nta_code: 'MN11',
    name: 'Central Harlem South',
    full_name: 'Central Harlem South',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.804587,
    center_lng: -73.950788,
    culture_tags: ["african_american", "historic", "music", "renaissance"],
    transit_lines: ["2", "3", "A", "B", "C", "D"],
    landmarks: ["Apollo Theater", "125th Street", "Sylvia's Restaurant", "Studio Museum"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.941773, 40.807097], [-73.952103, 40.811451], [-73.953577, 40.809485], [-73.954968, 40.810073], [-73.958183, 40.805605], [-73.95825, 40.803115], [-73.959648, 40.801165], [-73.958174, 40.800591], [-73.949235, 40.79688], [-73.948313, 40.798137], [-73.944601, 40.803233], [-73.946133, 40.803886], [-73.944303, 40.806399], [-73.941773, 40.807097]]]}),
  },
  {
    id: 'zone_mn_mn09',
    nta_code: 'MN09',
    name: 'Morningside Heights',
    full_name: 'Morningside Heights',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.808554,
    center_lng: -73.95933,
    culture_tags: ["academic", "historic", "religious"],
    transit_lines: ["1", "B", "C"],
    landmarks: ["Columbia University", "Cathedral of St. John the Divine", "Morningside Park", "Riverside Church"],
    difficulty_rating: 2,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.952103, 40.811451], [-73.95626, 40.813398], [-73.959495, 40.817016], [-73.962032, 40.818095], [-73.963405, 40.816692], [-73.968854, 40.80876], [-73.972873, 40.803364], [-73.960032, 40.798046], [-73.958174, 40.800591], [-73.959648, 40.801165], [-73.95825, 40.803115], [-73.958183, 40.805605], [-73.954968, 40.810073], [-73.953577, 40.809485], [-73.952103, 40.811451]]]}),
  },
  {
    id: 'zone_mn_mn06',
    nta_code: 'MN06',
    name: 'Manhattanville',
    full_name: 'Manhattanville',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.81919,
    center_lng: -73.953786,
    culture_tags: ["historic", "academic", "diverse"],
    transit_lines: ["1", "A", "B", "C", "D"],
    landmarks: ["Columbia Expansion", "Manhattanville Houses", "West Harlem Piers"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.94608, 40.821271], [-73.949923, 40.822081], [-73.95083, 40.820836], [-73.956342, 40.823101], [-73.95951, 40.823604], [-73.95794, 40.822783], [-73.962032, 40.818095], [-73.959495, 40.817016], [-73.95626, 40.813398], [-73.952103, 40.811451], [-73.948836, 40.815372], [-73.94608, 40.821271]]]}),
  },
  {
    id: 'zone_mn_mn03',
    nta_code: 'MN03',
    name: 'Central Harlem North',
    full_name: 'Central Harlem North-Polo Grounds',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.821916,
    center_lng: -73.939626,
    culture_tags: ["african_american", "historic", "jazz", "soul_food"],
    transit_lines: ["2", "3", "B", "C"],
    landmarks: ["Polo Grounds Towers", "Harlem River Drive", "Rucker Park"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.934454, 40.835989], [-73.93819, 40.833278], [-73.940143, 40.83038], [-73.938642, 40.829747], [-73.93925, 40.828305], [-73.942925, 40.823269], [-73.945161, 40.820887], [-73.94608, 40.821271], [-73.948836, 40.815372], [-73.952103, 40.811451], [-73.941773, 40.807097], [-73.938546, 40.805738], [-73.935809, 40.809506], [-73.939019, 40.810865], [-73.934076, 40.817835], [-73.933831, 40.819499], [-73.934425, 40.827051], [-73.935169, 40.832883], [-73.934454, 40.835989]]]}),
  },
  {
    id: 'zone_mn_mn04',
    nta_code: 'MN04',
    name: 'Hamilton Heights',
    full_name: 'Hamilton Heights',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.826765,
    center_lng: -73.947565,
    culture_tags: ["historic", "brownstone", "dominican", "academic"],
    transit_lines: ["1", "A", "B", "C", "D"],
    landmarks: ["Hamilton Grange", "City College", "St. Nicholas Park"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.940348, 40.830466], [-73.949576, 40.834428], [-73.950157, 40.834405], [-73.954543, 40.82787], [-73.95726, 40.827126], [-73.95951, 40.823604], [-73.956342, 40.823101], [-73.95083, 40.820836], [-73.949923, 40.822081], [-73.94608, 40.821271], [-73.945161, 40.820887], [-73.942925, 40.823269], [-73.93925, 40.828305], [-73.938642, 40.829747], [-73.940143, 40.83038], [-73.940348, 40.830466]]]}),
  },
  {
    id: 'zone_mn_mn36',
    nta_code: 'MN36',
    name: 'Washington Heights South',
    full_name: 'Washington Heights South',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.842405,
    center_lng: -73.940987,
    culture_tags: ["dominican", "diverse", "food"],
    transit_lines: ["1", "A", "C"],
    landmarks: ["George Washington Bridge", "Highbridge Park", "Morris-Jumel Mansion"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.931395, 40.847437], [-73.936398, 40.849549], [-73.939572, 40.851277], [-73.942991, 40.850827], [-73.943179, 40.849808], [-73.946928, 40.850536], [-73.946791, 40.847005], [-73.946126, 40.843901], [-73.94843, 40.839869], [-73.950157, 40.834405], [-73.949576, 40.834428], [-73.940348, 40.830466], [-73.939531, 40.832961], [-73.937938, 40.834466], [-73.936385, 40.837858], [-73.935057, 40.839342], [-73.935568, 40.841721], [-73.931395, 40.847437]]]}),
  },
  {
    id: 'zone_mn_mn35',
    nta_code: 'MN35',
    name: 'Washington Heights North',
    full_name: 'Washington Heights North',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.856715,
    center_lng: -73.932847,
    culture_tags: ["dominican", "food", "parks", "historic"],
    transit_lines: ["1", "A", "C"],
    landmarks: ["Fort Tryon Park", "The Cloisters", "Bennett Park"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.928728, 40.86675], [-73.9322, 40.869853], [-73.932427, 40.867577], [-73.937559, 40.86009], [-73.943028, 40.852634], [-73.946928, 40.850536], [-73.943179, 40.849808], [-73.942991, 40.850827], [-73.939572, 40.851277], [-73.936398, 40.849549], [-73.931395, 40.847437], [-73.929709, 40.848131], [-73.927478, 40.850703], [-73.927697, 40.852496], [-73.924693, 40.85665], [-73.925083, 40.857965], [-73.927124, 40.858118], [-73.924743, 40.861602], [-73.927271, 40.865543], [-73.928728, 40.86675]]]}),
  },
  {
    id: 'zone_mn_mn01',
    nta_code: 'MN01',
    name: 'Marble Hill-Inwood',
    full_name: 'Marble Hill-Inwood',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.869336,
    center_lng: -73.916156,
    culture_tags: ["dominican", "irish", "parks", "nature"],
    transit_lines: ["1", "A"],
    landmarks: ["Inwood Hill Park", "The Cloisters", "Fort Tryon Park", "Dyckman Street"],
    difficulty_rating: 4,
    boundary: JSON.stringify({"type": "MultiPolygon", "coordinates": [[[[-73.922046, 40.856862], [-73.919504, 40.858799], [-73.917053, 40.861901], [-73.91392, 40.864754], [-73.911032, 40.869164], [-73.91065, 40.872305], [-73.911579, 40.87328], [-73.914011, 40.871169], [-73.918461, 40.87303], [-73.919256, 40.871016], [-73.921533, 40.869458], [-73.9262, 40.868522], [-73.928728, 40.86675], [-73.927271, 40.865543], [-73.924743, 40.861602], [-73.922046, 40.856862]]], [[[-73.907466, 40.873556], [-73.90683, 40.87664], [-73.9095, 40.878785], [-73.91206, 40.878128], [-73.915787, 40.875725], [-73.911673, 40.874496], [-73.908934, 40.872166], [-73.907466, 40.873556]]]]}),
  },
  {
    id: 'zone_mn_centralpark',
    nta_code: 'MN99',
    name: 'Central Park',
    full_name: 'Central Park',
    borough: 'Manhattan',
    city: 'nyc',
    center_lat: 40.782272,
    center_lng: -73.965432,
    culture_tags: ["park", "nature", "recreation", "tourist", "iconic"],
    transit_lines: ["A", "B", "C", "D", "1", "2", "3", "N", "Q", "R", "W", "4", "5", "6"],
    landmarks: ["Bethesda Fountain", "Bow Bridge", "Sheep Meadow", "The Reservoir", "Belvedere Castle", "The Mall", "Strawberry Fields", "Central Park Zoo"],
    difficulty_rating: 3,
    boundary: JSON.stringify({"type": "Polygon", "coordinates": [[[-73.981773, 40.768094], [-73.958209, 40.800621], [-73.949227, 40.796875], [-73.972802, 40.764354], [-73.981773, 40.768094]]]}),
  }
]

const ALL_MANHATTAN_ZONE_IDS = ["zone_mn_mn25", "zone_mn_mn28", "zone_mn_mn27", "zone_mn_mn24", "zone_mn_mn22", "zone_mn_mn23", "zone_mn_mn50", "zone_mn_mn21", "zone_mn_mn20", "zone_mn_mn13", "zone_mn_mn19", "zone_mn_mn17", "zone_mn_mn31", "zone_mn_mn15", "zone_mn_mn40", "zone_mn_mn14", "zone_mn_mn32", "zone_mn_mn12", "zone_mn_mn33", "zone_mn_mn34", "zone_mn_mn11", "zone_mn_mn09", "zone_mn_mn06", "zone_mn_mn03", "zone_mn_mn04", "zone_mn_mn36", "zone_mn_mn35", "zone_mn_mn01", "zone_mn_centralpark"]

// ---------------------------------------------------------------------------
// Canonical maps (top-level `maps` collection — replaces `map_sets`).
//
// Each map is a named, selectable area. Zones belong to exactly ONE map via
// their `map_id`; there is no `zone_ids` array on a map. Doc ids are reused
// verbatim from the legacy map_sets so the port is a clean 1:1.
// ---------------------------------------------------------------------------
const MAP_MANHATTAN_ID = 'manhattan_neighborhoods'
const MAP_BROOKLYN_ID = 'brooklyn_alpha_d33_36'

interface CanonicalMap {
  id: string
  name: string
  description: string
  city: string
  borough: string
  map_center: { lat: number; lng: number; zoom: number }
  is_active: boolean
  recommended_teams: number
  recommended_duration: number
}

const CANONICAL_MAPS: CanonicalMap[] = [
  {
    id: MAP_BROOKLYN_ID,
    name: 'Brooklyn Alpha (D33–36)',
    description: 'Original alpha test map — Brooklyn City Council Districts 33, 34, 35, 36.',
    city: 'nyc',
    borough: 'Brooklyn',
    map_center: { lat: 40.6782, lng: -73.9442, zoom: 12 },
    is_active: true,
    recommended_teams: 3,
    recommended_duration: 180,
  },
  {
    id: MAP_MANHATTAN_ID,
    name: 'Manhattan (Full Borough)',
    description: '29 zones covering all of Manhattan — Lower Manhattan to Inwood, plus Central Park.',
    city: 'nyc',
    borough: 'Manhattan',
    map_center: { lat: 40.7831, lng: -73.9712, zoom: 12 },
    is_active: true,
    recommended_teams: 5,
    recommended_duration: 180,
  },
]

export default function SeedMaps() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  const log = (msg: string) => setStatus((prev) => [...prev, msg])

  const seedManhattanZones = async () => {
    log('--- Seeding Manhattan zones (29 total) ---')
    let created = 0
    for (const zone of MANHATTAN_ZONES) {
      try {
        await setDoc(doc(db, 'zones', zone.id), {
          id: zone.id,
          map_id: MAP_MANHATTAN_ID,   // every zone belongs to exactly one map
          nta_code: zone.nta_code,
          name: zone.name,
          full_name: zone.full_name,
          borough: 'Manhattan',
          city: 'nyc',
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
      } catch (err) {
        log(`  \u2717 ${zone.name} \u2014 ${(err as Error).message}`)
      }
    }
    log(`Manhattan zones: ${created} written`)
  }

  // -------------------------------------------------------------------------
  // Seed the top-level `maps` collection.
  //
  // Writes the two canonical maps, then ports any OTHER legacy map_sets found
  // in the database into `maps` (dropping their zone_ids array \u2014 membership now
  // lives on the zone via map_id, backfilled by migrateZoneMapIds below).
  // -------------------------------------------------------------------------
  const seedMaps = async () => {
    log('--- Seeding `maps` collection ---')

    // Canonical maps (Brooklyn Alpha + Manhattan)
    for (const m of CANONICAL_MAPS) {
      try {
        await setDoc(doc(db, 'maps', m.id), {
          id: m.id,
          name: m.name,
          description: m.description,
          city: m.city,
          borough: m.borough,
          map_center: m.map_center,
          is_active: m.is_active,
          recommended_teams: m.recommended_teams,
          recommended_duration: m.recommended_duration,
          created_at: new Date(),
        }, { merge: true })
        log(`  \u2713 map: ${m.name} (${m.id})`)
      } catch (err) {
        log(`  \u2717 map: ${m.name} \u2014 ${(err as Error).message}`)
      }
    }

    // Port any additional legacy map_sets (beyond the two canonical ids) so a
    // production DB with extra map sets doesn't lose them. zone_ids is dropped.
    try {
      const legacySnap = await getDocs(collection(db, 'map_sets'))
      const canonicalIds = new Set(CANONICAL_MAPS.map((m) => m.id))
      let ported = 0
      for (const d of legacySnap.docs) {
        if (canonicalIds.has(d.id)) continue
        const data = d.data()
        const rest: Record<string, any> = { ...data }
        delete rest.zone_ids   // membership now lives on the zone (map_id), not the map
        await setDoc(doc(db, 'maps', d.id), {
          ...rest,
          id: d.id,
          is_active: data.is_active ?? true,
          created_at: data.created_at ?? new Date(),
        }, { merge: true })
        ported++
        log(`  \u2713 ported legacy map_set \u2192 map: ${data.name || d.id} (${d.id})`)
      }
      if (ported === 0) log('  (no extra legacy map_sets to port)')
    } catch (err) {
      log(`  \u2717 porting legacy map_sets \u2014 ${(err as Error).message}`)
    }

    log('Maps seeded.')
  }

  // -------------------------------------------------------------------------
  // Backfill `map_id` onto every zone (one-time migration).
  //
  // Assignment is FIRST-WINS across these passes, so a zone that legacy data
  // listed under two maps keeps its first assignment and is logged as a
  // conflict for you to split into a second doc manually \u2014 the script never
  // duplicates or deletes zones on its own.
  //
  //   Pass 1  existing map_sets' zone_ids (data-driven, authoritative)
  //   Pass 2  known Manhattan zone list        \u2192 manhattan_neighborhoods
  //   Pass 3  Brooklyn scan (borough/legacy id) \u2192 brooklyn_alpha_d33_36
  //
  // Any zone still unassigned afterwards is reported as an orphan.
  // -------------------------------------------------------------------------
  const migrateZoneMapIds = async () => {
    log('--- Backfilling zone.map_id ---')

    const zonesSnap = await getDocs(
      query(collection(db, 'zones'), where('city', '==', 'nyc'))
    )
    const allZoneIds = new Set(zonesSnap.docs.map((d) => d.id))

    const assignment = new Map<string, string>()   // zoneId -> mapId (first-wins)
    const conflicts: string[] = []

    const assign = (zoneId: string, mapId: string) => {
      if (!allZoneIds.has(zoneId)) return           // map lists a zone that doesn't exist
      const existing = assignment.get(zoneId)
      if (existing === undefined) {
        assignment.set(zoneId, mapId)
      } else if (existing !== mapId) {
        conflicts.push(`${zoneId}: kept ${existing}, also claimed by ${mapId}`)
      }
    }

    // Pass 1 \u2014 existing map_sets (sorted by id for deterministic first-wins)
    try {
      const legacySnap = await getDocs(collection(db, 'map_sets'))
      const sorted = [...legacySnap.docs].sort((a, b) => a.id.localeCompare(b.id))
      for (const d of sorted) {
        const ids: string[] = d.data().zone_ids || []
        for (const zid of ids) assign(zid, d.id)
      }
    } catch (err) {
      log(`  \u2717 reading map_sets \u2014 ${(err as Error).message}`)
    }

    // Pass 2 \u2014 known Manhattan zones
    for (const zid of ALL_MANHATTAN_ZONE_IDS) assign(zid, MAP_MANHATTAN_ID)

    // Pass 3 \u2014 Brooklyn zones (borough=Brooklyn, or legacy non-zone_mn_ ids)
    zonesSnap.forEach((d) => {
      const data = d.data()
      if (data.borough === 'Brooklyn' || (!data.borough && !d.id.startsWith('zone_mn_'))) {
        assign(d.id, MAP_BROOKLYN_ID)
      }
    })

    // Backfill the resolved assignments
    let written = 0
    for (const [zoneId, mapId] of assignment) {
      try {
        await setDoc(doc(db, 'zones', zoneId), { map_id: mapId }, { merge: true })
        written++
      } catch (err) {
        log(`  \u2717 ${zoneId} \u2014 ${(err as Error).message}`)
      }
    }
    log(`  \u2713 assigned map_id to ${written} zones`)

    // Report conflicts (shared-across-maps in legacy data)
    if (conflicts.length > 0) {
      log(`  \u26a0 ${conflicts.length} zone(s) were claimed by multiple maps (kept first, split manually if needed):`)
      conflicts.forEach((c) => log(`      ${c}`))
    }

    // Report orphans (zones with no map after all passes)
    const orphans = [...allZoneIds].filter((zid) => !assignment.has(zid))
    if (orphans.length > 0) {
      log(`  \u26a0 ${orphans.length} zone(s) have NO map_id \u2014 assign a map manually:`)
      orphans.forEach((zid) => log(`      ${zid}`))
    } else {
      log('  \u2713 no orphan zones \u2014 every zone has a map_id')
    }
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
    log('Starting seed + migration...')
    await addBoroughToExistingZones()
    await seedManhattanZones()
    await seedMaps()
    await migrateZoneMapIds()
    log('')
    log('\u2705 All done! `maps` collection seeded and every zone has a map_id.')
    setRunning(false)
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#FDFFF1',
      color: '#202122',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      padding: '32px 24px',
    }}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: '#6F6E66', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: 4 }}>
          Seed Maps & Zones
        </h1>
        <p style={{ color: '#5F5E57', fontSize: '0.85rem', marginBottom: 24 }}>
          Seeds 29 Manhattan zones + the `maps` collection, and backfills map_id on every zone
        </p>

        <div style={{
          background: 'rgba(255,214,38,0.06)',
          border: '1px solid rgba(255,214,38,0.2)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 24,
        }}>
          <p style={{ color: '#FFD626', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            This will:
          </p>
          {[
            'Add borough: "Brooklyn" to existing zone docs (if missing)',
            'Create/update 29 Manhattan zones in Firestore, each stamped with map_id',
            'Seed the `maps` collection: "Brooklyn Alpha" + "Manhattan (Full Borough)" (+ port any extra legacy map_sets)',
            'Backfill map_id onto every zone (first-wins; warns on shared/orphan zones)',
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <span style={{ color: '#FFD626' }}>{i + 1}.</span>
              <span style={{ color: '#3A3935', fontSize: '0.88rem' }}>{item}</span>
            </div>
          ))}
        </div>

        <button
          onClick={runAll}
          disabled={running}
          style={{
            width: '100%',
            background: running ? '#E6E5DA' : 'rgba(40,183,112,0.12)',
            border: '1px solid ' + (running ? '#E6E5DA' : 'rgba(40,183,112,0.3)'),
            color: running ? '#8F8E85' : '#28B770',
            padding: '16px 24px',
            borderRadius: 12,
            fontSize: '1rem',
            fontWeight: 700,
            cursor: running ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            marginBottom: 20,
          }}
        >
          {running ? 'Seeding...' : '\uD83C\uDF31 Seed All Zones + Map Sets'}
        </button>

        {status.length > 0 && (
          <div style={{
            background: '#FDFFF1',
            border: '1px solid #E6E5DA',
            borderRadius: 10,
            padding: 16,
            fontFamily: "'Martian Mono', monospace",
            fontSize: '0.78rem',
            lineHeight: 1.8,
            maxHeight: 400,
            overflowY: 'auto',
          }}>
            {status.map((line, i) => (
              <div key={i} style={{
                color: line.includes('\u2713') ? '#28B770'
                  : line.includes('\u2717') ? '#FF4443'
                  : line.includes('\u2705') ? '#28B770'
                  : line.startsWith('---') ? '#FFD626'
                  : '#55544E',
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