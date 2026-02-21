import { doc, setDoc } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { zones } from '../lib/zones'

export async function seedZonesAndCity() {
  console.log('Seeding zones...')

  for (const zone of zones) {
    await setDoc(doc(db, 'zones', zone.id), {
      id: zone.id,
      district_number: zone.district_number,
      name: zone.name,
      city: zone.city,
      boundary: JSON.stringify(zone.boundary),
      center_lat: zone.center_lat,
      center_lng: zone.center_lng,
      culture_tags: zone.culture_tags,
      transit_lines: zone.transit_lines,
      landmarks: zone.landmarks,
      difficulty_rating: zone.difficulty_rating,
    })
    console.log('  done: ' + zone.name)
  }

  await setDoc(doc(db, 'cities', 'nyc'), {
    id: 'nyc',
    name: 'New York City',
    country: 'US',
    default_zones: zones.map((z) => z.id),
    map_center: { lat: 40.6982, lng: -73.9442, zoom: 12 },
    transit_system: 'Subway',
    language: 'en',
    currency: 'USD',
    is_active: true,
  })
  console.log('  done: NYC city')
  console.log('All done!')
}