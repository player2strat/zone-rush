# Foray

Team-based urban scavenger hunt. A Game Master builds a map of zones, players
join by code, and teams race to claim zones by completing photo/video
challenges on the ground. Side quests (like pothole reporting) run as
photo tallies across the whole game.

## Stack

- **React + TypeScript + Vite** — single-page app in `src/`
- **Firebase** — Auth, Firestore, Storage (project `zonerush-9f2db`, console
  name "zone-rush-alpha"). Config comes from `.env.local` (`VITE_FIREBASE_*`),
  which is not committed — ask a teammate for a copy.
- **Mapbox GL** — maps and the Zone Builder (`VITE_MAPBOX_TOKEN` in `.env.local`)
- **Vercel** — hosting; SPA rewrite in `vercel.json`

## Run it

```bash
npm install
npm run dev
```

## Key places

| Path | What it is |
| --- | --- |
| `src/pages/` | One file per screen (home, create/join, lobby, game, GM dashboard, results, admin tools) |
| `src/lib/` | Game logic: scoring, end-game bonuses, zone geometry, dealing, activity log |
| `src/components/` | Shared UI (game map, proof submission, side quests) |
| `firestore.rules` | **Source of truth for security rules** — paste into the Firebase console (Firestore → Rules → Publish) after every change; there is no CLI auto-deploy |
| `ROADMAP.md` | Deferred work + the playtest checklist |
| `data/` | Raw GeoJSON used to seed maps/zones |

## Things to know

- Roles live on `users/{uid}.role` (`player` / `gm` / `admin`), set from the
  Firebase console. The rules prevent self-promotion.
- Firestore rules and indexes are managed **manually in the console** — the
  repo file is canonical, but publishing is a manual step.
- Each game snapshots its zones into `games/{id}/zones` at creation, so
  editing the zone library never breaks past games.
