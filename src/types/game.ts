export interface Zone {
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