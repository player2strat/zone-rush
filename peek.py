import json

with open('alpha_zones.json', 'r') as f:
    zones = json.load(f)

ts = '''export interface Zone {
  id: string;
  district_number: number;
  name: string;
  city: string;
  boundary: {
    type: string;
    coordinates: number[][][];
  };
  center_lat: number;
  center_lng: number;
  culture_tags: string[];
  transit_lines: string[];
  landmarks: string[];
  difficulty_rating: number;
}

'''

ts += 'export const zones: Zone[] = '
ts += json.dumps(zones, indent=2)
ts += ';\n'

with open('src/lib/zones.ts', 'w') as f:
    f.write(ts)

print('Regenerated src/lib/zones.ts with inline Zone type + data')