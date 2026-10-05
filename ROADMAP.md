# Zone Rush — Roadmap / Deferred Work

A running list of planned and deferred work. Kept in the repo so it travels with
the code and syncs into the claude.ai project (if connected as a knowledge source).

## Zone Builder — zone editing

**Shipped**
- Draw/edit/delete zones; duplicate maps; boundary draw + GeoJSON import; coverage/gap overlay; publish.
- "Fit neighbors" carve — an edited/drawn zone wins the contested area and overlapping neighbors are trimmed to a clean shared border on save.
- **Merge tool** — pick a zone to keep, then an adjacent zone; the second is unioned into the first and deleted. Tags/transit/landmarks combined; name editable before confirm.
- **Split tool** — pick a zone, draw a line across it; preview both halves (green keeps the zone's id, yellow becomes a new zone copying its metadata), name them, confirm. Both refuse while games are in progress on the map.
- **Fill-gap tool** — orange coverage-gap slivers are clickable; pick an adjacent zone (only zones that touch the sliver are offered) and confirm → the sliver is unioned into that zone.
- **Border snapping** — draw-time and edit-time. Points placed while drawing, and vertices dragged while editing, snap onto nearby zone borders / the map boundary (12px screen radius, `SNAP_PIXELS` in `src/pages/ZoneBuilder.tsx`), with a pink indicator dot.

**Deferred follow-ups** (rough priority)
1. **Snap radius tuning** — adjust `SNAP_PIXELS` (currently 12) if snapping feels too grabby or too loose in real use.
2. **Alt-to-bypass snapping** — hold a modifier key to place a point near-but-not-on a border without snapping.

## Game data safety

- **Verify the `teams` collection-group index exists** in the Firebase console. `App.tsx` `findActiveGameForUser` runs `collectionGroup('teams')` + `array-contains` on `members`, which needs a collection-group-scoped index on `members`; if it's missing, the query fails silently and players are never auto-returned to their game.

- **Shipped (2026-08-22): per-game zone snapshot.** `CreateGame` copies every selected zone doc into `games/{id}/zones/{zoneId}` in the same batch as the game. `src/lib/gameZones.ts` `loadGameZones()` is the one reader (GamePage, GMDashboard, ResultsPage, SubmitProof, activity log); it falls back to the global `zones` collection for games created before this. Library edits/merges/splits/deletes can no longer alter a game's history.
  - Follow-up: a one-off backfill for games created before the snapshot (copy their `game.zones` ids from the library while those zones still exist).
  - Follow-up: with snapshots in place, the merge/split "blocked while games are in progress" guard is now conservative rather than necessary; could be relaxed.

## Playtest checklist (features shipped but not yet verified in a real game)

- [ ] **Side quests** — create a game with the Pothole Reporting preset; players submit photos from the home tab (tally shows approved/pending); every quest card shows an all-team leaderboard of approved counts (crown on the leader, own team highlighted, other teams' pending never shown) that updates live as the GM approves; GM approves/rejects in the Submissions tab's Side Quests box; team totals unchanged during play; post-game bonus card pre-picks the leader; Lock In records the winners but team totals (and the players' own score) stay unchanged until the champion is revealed; players never see bonus point values before the reveal; per-game and all-time (Side Quest Explorer) CSV exports open with correct GPS links.
- [ ] **Results reveal** — end a game, Lock In Bonus Points on the GM dashboard, then tap through the reveal: players (one in the room, one remote) see only their own pre-bonus score until the first tap, then pre-bonus standings, one bonus card per tap (winner in team color, "That's you!" on the winning team's phones, tie card when nobody wins), then the countdown from last place to the champion with confetti. Back and Restart work; a player who opens the results page late lands on the current stage; the GM's "On players' screens now" preview matches the phones.
- [ ] **Game access lockdown** — rollout, with no game running: (1) publish `firestore.rules` in the console, (2) push the app, (3) an admin account opens /admin/seed-maps and clicks "Backfill game rosters + join codes" once. Founder accounts must have role `admin` (GM-role accounts now see only games they created). Then check: a fresh account can join a lobby by code, pick a team, switch teams, rename itself, leave; a second fresh account that never entered the code gets sent home from /lobby/<id>, /game/<id> and /results/<id>. In a running game: chat shows only your own team's messages plus GM broadcasts (GM sees all); a player can still discard once, submit proof, withdraw a pending one, and post side quests; the clock running out ends the game. Late join: entering the code mid-game shows "This game is in progress", the request reaches the GM, approval drops the player into the game; reloading the late-join page asks for the code again. Old games: Past Forays and old results pages still open for their players after the backfill. GM-role account: Side Quest Explorer says admins only; Zone Builder map delete/merge/split say admins only.
- [ ] **Practice games** — tick "Practice game" when creating; GM header shows a PRACTICE badge; after the reveal the panel says it's not recorded and profiles/leaderboard stay unchanged; "Make it count" then "Record results now" adds it. On a real game that was recorded, "This was a test — remove from leaderboard" deletes its results and reverses games played / wins on each profile.
- [ ] **Highlight reels** — set REEL_MOCK=1 in Vercel first: run a reveal; GM panel shows "🎬 Highlight reels" with each team ✅ ready (sample video); results page shows the reel with a Share button; Past Forays row shows "Reel ready"; lobby shows the photo consent line. Then real mode: add CREATOMATE_API_KEY, REEL_WEBHOOK_SECRET, FIREBASE_SERVICE_ACCOUNT (+ optional REEL_MUSIC_URL, FIREBASE_STORAGE_BUCKET, RESEND_API_KEY, REEL_FROM_EMAIL), remove REEL_MOCK; a reveal should flip teams to ⏳ rendering then ✅ ready within minutes, the video should be 9:16 with intro, captions, outro, music; the copied file should live under reels/ in Storage; players get the email.
- [ ] **Profiles, badges, leaderboard** — needs the `game_results` rule published. Run a full reveal; the GM panel should say "Results recorded". Home → My Profile shows the game, stats, and a badge wall (First Foray + Podium/Champion at least); Leaderboard lists every player with placement points (10/7/5/3), City tab shows NYC, Region tab shows "Unassigned" until city docs get a `region`; tapping a row opens that player's profile. For games ended before this shipped, the GM panel's "Record results now" backfills them. Play twice with the same roster → Reunited badge and a crew line on the profile.
- [ ] **Reveal extras** — (a) champion drumroll: the last tap shows "And the champion is… 3, 2, 1" before the card, confetti falls in the winner's team color, Android phones buzz; Back then Next replays it. (b) Live reactions: once the reveal starts, players get a five-emoji bar at the bottom of the results page; taps float up the right edge on every player phone AND on the GM dashboard, labelled with the team name; one tap per ~1s per phone. Needs the `reactions` rule from firestore.rules published in the console first. (d) Distance covered: play a game with GPS on; the results page's own-team card shows "X mi covered" (feet under 0.1 mi) and the recap card gets a fourth tile; team distance is the highest member total; check the number is plausible against a maps estimate of the route (subway hops count as straight lines). (e) Share carousel: after the champion is revealed the results page shows a swipeable row of two cards, team recap and zone map (zones in team colors, locked zones with a heavy outline, legend with counts); each has Share, plus Share all; on a phone the share sheet offers Save Image. (f) Steal alert: when another team takes a zone you held, a red banner names the thief with a "Take it back" button that opens the map. (c) Team recap card: after the champion is revealed, "Share your team recap" builds a 9:16 PNG (team, place, points, zones, challenges, members) and opens the phone's share sheet (downloads on desktop).
- [ ] **Zone opening schedule** — create a game with one zone set to "opens at 15 min"; confirm it starts closed on all maps, rejects submissions, and flips open on schedule while the GM dashboard is open (schedules now run only there; also try backgrounding the GM's phone past the minute and reopening).
- [ ] **Zone closure schedule** — still fires correctly alongside an opening (set both on different zones in one game).
- [ ] **Teammates on map** — two players on one team; each sees the other's dot (team color, first name) on the Map tab; dot disappears ~5 min after a phone goes dark.
- [ ] **Withdraw pending submission** — submit a photo, cancel via expanded card and via the ↺ chip on the collapsed card; card returns to Submit; GM's pending queue updates live; resubmit works.
- [ ] **Player post-game view** — finished game shows final zone map + team submissions gallery (photos open, videos play, deleted-media placeholder shows).
- [ ] **Past Forays page** — home → Past Forays lists finished games with team name/color, GM badge, date; rows open the right results.
- [ ] **Late join** — enter code for an in-progress game on a fresh account → name → waiting screen → GM approves from dashboard banner → player lands in game on the right team. Also test Deny and Cancel request.
- [ ] **GM/player home split** — player account sees only Join Game; typing /create redirects home; player creating a game via console is rejected by rules.
- [ ] **Leave Lobby** — player leaves an unstarted lobby, home no longer bounces them back; rejoining via code works.
- [ ] **Per-game zone snapshot** — create a game, then edit/split one of its zones in Zone Builder; the live game's map is unchanged.
- [ ] **Zone Builder tools** — fill-gap, merge, split on a scratch map (duplicate a real one first); map delete blocked while a game is live.

## Security follow-ups (from the Oct 2026 review)

- **Teammates-only locations?** — founders to decide whether players should see every player's position or only their own team's. Today positions sit on the team docs, so everyone in the same game receives them (strangers no longer can). Teammates-only means moving them to `games/{g}/teams/{t}/locations/{uid}` readable by that team + GM, and clearing them when the game ends.
- **Discard picks its own card** — the player's phone draws the "random" replacement, so a cheater could choose it. Fix: draw on the GM side or in a Vercel function.
- **Self-reported distance** — a player can still set their own distance to anything (badges/recap only, not points). Fix: cap in the rules or clamp in `recordGameResults`.
- **CYOA peeking** — `final_task` is readable in `challenges`, so players can see it before locking blind choices. Fix: serve it from a GM-only doc.
- **Undo-window swap** — during the GM's 15s undo, a player could withdraw and re-create a submission with the same id. Fix: pass the reviewed snapshot to `approveSubmission` and abort if it changed.
- **Two teams at once** — the rules can't stop one account joining two lobby teams via direct writes (the GM would see the name twice). `recordGameResults` could count each uid once.
- **Zone steal without out-scoring** — scoring bug, not cheating: a team reaching the claim threshold takes a zone even if the holder has more points (`scoring.ts`). Worth a look.
- **Storage rules** — not in the repo; confirm in the console that uploads are limited to signed-in users and listing is off.
- **Reel email** — before turning email on, send one email per recipient (or BCC) instead of one shared To: line.

## Zone schedules

- **Server-side schedule guarantee** — zone open/close schedules run only on the GM dashboard (on load, foreground, and once a minute; writes are atomic) — the security rules don't let players change which zones are open. If the GM's screen is asleep, a change lands when it wakes. A Vercel cron using the existing Admin SDK (`api/_lib/admin.ts`), or a Cloud Functions scheduled job (Blaze plan), would make timing exact.

## Zone Manager

- **City-filter the zone load** — currently loads every zone in the DB (no city filter), which won't scale as more zones/cities are added. Filter the load by selected city; the per-map filter already exists in the UI.
- The "Save selected zones as a new map" panel overlaps with the Zone Builder's scoped "Import map from GeoJSON" flow (the preferred path). Kept for now; consider removing later to avoid two ways to do the same thing.
