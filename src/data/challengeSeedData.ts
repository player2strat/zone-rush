// =============================================================================
// Zone Rush — Challenge Seed Data
// Source: PROMPTS V1 spreadsheet (40 challenges)
// Points: Easy = 1, Medium = 3, Hard = 5
//
// Fields added beyond spreadsheet:
//   - category: food | art | fitness | culture | humor | civic | exploration
//   - requires_interaction: boolean (involves talking to strangers)
//   - min_players: minimum players needed (1 = solo ok, 2+ = needs teammates)
//   - times_played / times_approved / times_rejected: running counters (start 0)
// =============================================================================

export interface ChallengeSeed {
  id: string;
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  points: number;
  time_estimate: "short" | "medium" | "long";
  player_profile: "adventurer" | "academic" | "gamer" | "ride_along";
  verification_type: "photo" | "video" | "audio";
  tier2: { description: string; bonus_points: number } | null;
  phone_free_eligible: boolean;
  is_time_based: boolean;
  requires_money: boolean;
  category: "food" | "art" | "fitness" | "culture" | "humor" | "civic" | "exploration";
  requires_interaction: boolean;
  min_players: number;
  times_played: number;
  times_approved: number;
  times_rejected: number;
  city_tags: string[];
  zone_tags: string[];
  is_active: boolean;
  source: "official" | "community" | "partner";
  created_by: string;
}

const POINTS = { easy: 1, medium: 3, hard: 5 };

export const challengeSeedData: Omit<ChallengeSeed, "created_by">[] = [
  {
    id: "ch_001", title: "Furthest Pizza",
    description: "Eat a slice of pizza at the pizza store the furthest away from you in the zone you're in.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "long", player_profile: "adventurer",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: true, category: "food", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_002", title: "Backwards Border Run",
    description: "Find the route that takes you to the closest zone the fastest (without public transit) and walk into the next zone backwards. One teammate may look forward as a guide.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "long", player_profile: "adventurer",
    verification_type: "video", tier2: null, phone_free_eligible: false, is_time_based: false,
    requires_money: false, category: "fitness", requires_interaction: false, min_players: 2,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_003", title: "Local Legend",
    description: "Talk to someone who has lived in the zone for 10+ years and ask their favorite place to eat and why. Follow up points for eating there.",
    difficulty: "hard", points: POINTS.hard, time_estimate: "long", player_profile: "adventurer",
    verification_type: "video",
    tier2: { description: "Actually eat at the place they recommended.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: true,
    category: "culture", requires_interaction: true, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_004", title: "Transit Boomerang",
    description: "Take the subway or bus into another zone and immediately return to your zone. Fastest time wins.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "long", player_profile: "adventurer",
    verification_type: "video", tier2: null, phone_free_eligible: false, is_time_based: true,
    requires_money: true, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_005", title: "OG Pizza Shop",
    description: "Eat a slice of pizza at the oldest pizza shop in your zone. You may use Wikipedia for this.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "medium", player_profile: "academic",
    verification_type: "photo",
    tier2: { description: "Meet the owner of the pizza shop.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: true,
    category: "food", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_006", title: "Council High Five",
    description: "High five in front of your zone's Councilmember's district office.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "academic",
    verification_type: "photo",
    tier2: { description: "Meet someone who works at the district office.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "civic", requires_interaction: false, min_players: 2,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_007", title: "Birthday Hunter",
    description: "Find someone celebrating their birthday or anniversary.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "academic",
    verification_type: "photo",
    tier2: { description: "The birthday or anniversary is within 2 weeks of the date you're playing.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "culture", requires_interaction: true, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_008", title: "Rock Meets Tree",
    description: "Find the coolest rock. Present it to the coolest tree so they can become friends. If challenged, the GMs will decide.",
    difficulty: "hard", points: POINTS.hard, time_estimate: "long", player_profile: "gamer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_009", title: "Beach by the Numbers",
    description: "Visit the beach for the number of minutes equal to your zone number.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "adventurer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: true,
    requires_money: false, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_010", title: "Vendor's Choice",
    description: "Ask any street vendor what their favorite order is, and order that.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "long", player_profile: "adventurer",
    verification_type: "video",
    tier2: { description: "Eat it and leave a nice review.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: true,
    category: "food", requires_interaction: true, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_011", title: "Culture Cuisine",
    description: "Find a restaurant whose cuisine is of the most prominent culture in the zone. You may use Wikipedia.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "medium", player_profile: "academic",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "culture", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_012", title: "Law-Abiding Citizen",
    description: "When crossing the street, don't jaywalk for 4 blocks.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "gamer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_013", title: "Busker Fan",
    description: "Find someone busking. Listen to them jam the longest.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "gamer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: true,
    requires_money: false, category: "culture", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_014", title: "Street Karaoke",
    description: "Find your closest intersection. Sing a song that includes at least one word from one of the street names.",
    difficulty: "hard", points: POINTS.hard, time_estimate: "medium", player_profile: "gamer",
    verification_type: "video",
    tier2: { description: "Get someone else to sing along with you.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_015", title: "Cops on Break",
    description: "Take a picture of the most cops standing around doing nothing and playing on their phones.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "medium", player_profile: "gamer",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_016", title: "Fashion Runway",
    description: "Do a fashion show runway dance in front of the most fashionable shop or spot in your zone.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "medium", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_017", title: "Apple Juggler",
    description: "Juggle three apple-shaped objects together for 10 seconds.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "medium", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "fitness", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_018", title: "Mural Tour",
    description: "Pose in front of 3 murals in your zone.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "medium", player_profile: "ride_along",
    verification_type: "photo",
    tier2: { description: "All the murals are from the same artist.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "art", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_019", title: "Meet the Owner",
    description: "Take a picture with the owner of a local business.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "ride_along",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "culture", requires_interaction: true, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_020", title: "Bench Note",
    description: "Write a note and leave it on a bench for someone to pick up.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "adventurer",
    verification_type: "photo",
    tier2: { description: "See someone actually read it.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_021", title: "Litter Cleanup",
    description: "Find some litter and clean it up!",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "adventurer",
    verification_type: "photo",
    tier2: { description: "Also recycle something.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "civic", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_022", title: "Best Skyline",
    description: "Point at the most beautiful skyline. If challenged, the GMs will decide.",
    difficulty: "medium", points: POINTS.medium, time_estimate: "short", player_profile: "adventurer",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_023", title: "NYC Book Club",
    description: "Take a video reading a book about NYC for at least 30 seconds. The book must be at least 50 pages long.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "academic",
    verification_type: "video", tier2: null, phone_free_eligible: false, is_time_based: false,
    requires_money: false, category: "culture", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_024", title: "311 Reporter",
    description: "Report a traffic issue to 311 (i.e., pothole, broken traffic light).",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "academic",
    verification_type: "photo", tier2: null, phone_free_eligible: false, is_time_based: false,
    requires_money: false, category: "civic", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_025", title: "Bodega Price Hunt",
    description: "Pick an item for sale at a bodega. Find the same item at another bodega for a lower price.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "academic",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_026", title: "Oldest Street Strut",
    description: "Strut confidently across the oldest street in your zone. You may use Wikipedia for this.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "academic",
    verification_type: "video", tier2: null, phone_free_eligible: false, is_time_based: false,
    requires_money: false, category: "culture", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_027", title: "Statue Pose",
    description: "Pose next to a statue.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "academic",
    verification_type: "photo",
    tier2: { description: "It's the oldest statue in your zone. You may use Wikipedia for this.", bonus_points: 1 },
    phone_free_eligible: true, is_time_based: false, requires_money: false,
    category: "culture", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_028", title: "Playground Recess",
    description: "Go to the closest playground near you and play around for 30 seconds.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "gamer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "fitness", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_029", title: "Slowest Stairs",
    description: "Run up the stairs of a subway line. Slowest wins.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "gamer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: true,
    requires_money: false, category: "fitness", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_030", title: "Bagel Debate",
    description: "Have a heated debate about your bagel order in front of a bagel shop (or deli/bakery).",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "food", requires_interaction: false, min_players: 2,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["nyc"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_031", title: "Muffin Balance",
    description: "Balance a muffin (or muffin-sized object) on your hand while crossing the street.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_032", title: "Urban Nature",
    description: "Take a picture with one player fully surrounded by grass or trees. No buildings or cars.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "ride_along",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_033", title: "Imaginary Friends",
    description: "Wave convincingly to imaginary friends on a street corner until 3 real people wave back.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: true, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_034", title: "Crosswalk Dancer",
    description: "Subtly dance across 3 connected crosswalks.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "adventurer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_035", title: "Park Hero",
    description: "Pose heroically at the entrance to a park.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "adventurer",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_036", title: "Saddest Ice Cream",
    description: "Order ice cream the saddest.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: true, category: "humor", requires_interaction: true, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_037", title: "No Loitering Loiterer",
    description: "Loiter next to a \"No Loitering\" sign.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "ride_along",
    verification_type: "photo", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_038", title: "Hydrant Dance-Off",
    description: "Dance the longest next to a fire hydrant.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "medium", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: true,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_039", title: "Slowest Sip",
    description: "Drink a bottle of water the slowest.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "gamer",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: true,
    requires_money: false, category: "humor", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
  {
    id: "ch_040", title: "Bird Watcher",
    description: "Standing in one spot, film the most birds in 30 seconds.",
    difficulty: "easy", points: POINTS.easy, time_estimate: "short", player_profile: "ride_along",
    verification_type: "video", tier2: null, phone_free_eligible: true, is_time_based: false,
    requires_money: false, category: "exploration", requires_interaction: false, min_players: 1,
    times_played: 0, times_approved: 0, times_rejected: 0,
    city_tags: ["*"], zone_tags: [], is_active: true, source: "official",
  },
];

// =============================================================================
// Stats helper (console output during seed)
// =============================================================================
export function getChallengeStats() {
  const d = challengeSeedData;
  return {
    total: d.length,
    byDifficulty: {
      easy: d.filter((c) => c.difficulty === "easy").length,
      medium: d.filter((c) => c.difficulty === "medium").length,
      hard: d.filter((c) => c.difficulty === "hard").length,
    },
    byProfile: {
      adventurer: d.filter((c) => c.player_profile === "adventurer").length,
      academic: d.filter((c) => c.player_profile === "academic").length,
      gamer: d.filter((c) => c.player_profile === "gamer").length,
      ride_along: d.filter((c) => c.player_profile === "ride_along").length,
    },
    byCategory: {
      food: d.filter((c) => c.category === "food").length,
      art: d.filter((c) => c.category === "art").length,
      fitness: d.filter((c) => c.category === "fitness").length,
      culture: d.filter((c) => c.category === "culture").length,
      humor: d.filter((c) => c.category === "humor").length,
      civic: d.filter((c) => c.category === "civic").length,
      exploration: d.filter((c) => c.category === "exploration").length,
    },
    withTier2: d.filter((c) => c.tier2 !== null).length,
    timeBased: d.filter((c) => c.is_time_based).length,
    requiresMoney: d.filter((c) => c.requires_money).length,
    requiresInteraction: d.filter((c) => c.requires_interaction).length,
    needsTeammate: d.filter((c) => c.min_players >= 2).length,
  };
}