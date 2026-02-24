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

export interface Submission {
  id: string;
  game_id: string;
  team_id: string;
  challenge_id: string;
  zone_id: string;
  submitted_by: string;
  media_url: string;
  media_type: 'photo' | 'video' | 'audio';
  gps_lat: number | null;
  gps_lng: number | null;
  status: 'pending' | 'approved' | 'rejected';
  gm_notes: string;
  reviewed_by: string | null;
  reviewed_at: any;
  attempted_tier2: boolean;
  tier2_approved: boolean;
  phone_free_claimed: boolean;
  submitted_at: any;
}