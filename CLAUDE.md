# moviebot

Discord alert bot that polls Cineplex Bangladesh's ticket API and posts in a server
channel when a new showtime/ticket becomes available for a specific movie, at a fixed
date/location you configure in advance.

## How it works

- `src/config.ts` hardcodes the movie/date/location being watched (`MOVIE_ID`,
  `MOVIE_NAME`, `SHOW_DATE`, `LOCATION`) — not read from env — so there's exactly one
  source of truth and they can't drift out of sync with each other. The bot does not
  discover dates on its own (`get-showdate` isn't used); you tell it exactly which
  date/location to watch, e.g. because you already know when a movie is expected to
  open at your preferred cinema.
- `src/cineplexClient.ts`'s `fetchShows()` calls `POST {CINEPLEX_BASE_URL}/get-shows`
  with `{location, movieId, showDate}` from config to fetch the actual show sessions
  (times, halls, seat prices) on sale for that fixed date, plus `appsource` /
  `device-key` headers and a Bearer auth token.
- `src/showtimeDiff.ts` fingerprints each returned session entry and diffs against
  fingerprints stored **per channel** (in `discord_channels`, see `channelStore.ts`) to
  find sessions genuinely new *to that channel*. Tracking is per-channel, not global,
  so a server that adds the bot later doesn't inherit another server's "already seen"
  history and silently miss everything currently on sale. A channel's first poll posts
  whatever is on sale as a "now watching" catch-up; subsequent polls post only genuine
  changes.
- `src/guildSync.ts` detects which servers the bot is a member of and picks a channel
  to post alerts in for each one. It uses **Discord's REST API only** — no Gateway, no
  WebSocket, no `discord.js` dependency — because the bot runs on Vercel, where nothing
  stays alive between invocations to hold a socket open (see "Deployment: Vercel"
  below). `syncGuilds()` runs before every poll and reconciles in both directions:
  `GET /users/@me/guilds` is the authoritative membership list, so servers missing from
  the database get a channel registered, and registered servers missing from the list
  get pruned. Polling the list this way replaces the Gateway's `guildCreate` /
  `guildDelete` events, which can't be received without a persistent connection; the
  cost is that a join or kick is noticed on the next poll rather than instantly.
  Channel choice is the server's system channel if the bot can post there, otherwise
  the lowest-positioned text channel it can. `src/permissions.ts` computes that
  from raw REST data — union of `@everyone` and the bot's role permissions,
  short-circuited by Administrator, then `@everyone`, role, and member channel
  overwrites in Discord's documented order — reimplementing what discord.js's
  `permissionsFor` used to do. The chosen channel is registered via
  `src/channelStore.ts` in a `discord_channels` table in Postgres (auto-created, same
  as `poll_state`). No manual channel configuration: adding the bot to a server with
  permission to post somewhere is what makes that server start receiving alerts.
- `src/discordNotifier.ts` posts the same message directly into every registered
  channel via the bot's REST API (`DISCORD_BOT_TOKEN`), independently — one channel's
  failure (e.g. permissions revoked there) doesn't block posting to the others. Also
  posts a separate warning if the auth token expires — sent once per failure episode
  (tracked via `state.authAlertSent`), not repeated on every poll, and reset once a
  poll succeeds again so a future failure alerts again.
- `src/pollCycle.ts` holds the "do one poll" logic (fetch → diff → look up current
  channels → alert → return updated state). It is deliberately a one-shot function
  with no timing of its own, so the same code drives both entry points below.
- There are **two entry points**, one per hosting model, both calling the same
  `syncGuilds` → `runPollCycle` → `saveState` sequence:
  - `api/poll.ts` — used on Vercel. One HTTP request runs at most one poll, then
    returns. It has no timing of its own: an external scheduler decides when to call
    it. See "Deployment: Vercel" below.
  - `src/index.ts` — used by `npm run dev` / `npm start` locally, and by any always-on
    host. Loops forever on `POLL_INTERVAL_MS` via `setTimeout`, pacing itself in
    process. Not used on Vercel at all.
- `api/status.ts` answers "is it still checking?". `runPollCycle` stamps
  `last_polled_at` / `last_poll_status` / `last_session_count` onto `poll_state` on
  every attempt — success or failure — so the record survives the process and both
  entry points populate it without knowing about each other. `/api/status` reads that
  back as JSON with a `healthy` flag that goes false after three missed intervals.
  This exists because the bot is *supposed* to be silent for weeks: without it,
  "no tickets yet" and "died four hours ago" look identical from Discord.

## Discord alert setup

This needs an actual bot application (not a webhook) since it needs to detect which
servers it's in and post there automatically:

1. <https://discord.com/developers/applications> → New Application → **Bot** tab →
   Reset Token → copy it into `.env` as `DISCORD_BOT_TOKEN`.
2. Same app → **OAuth2** → URL Generator → scope `bot` → under **Bot Permissions**,
   check **View Channel** and **Send Messages** (this is required now — the bot
   posts in a channel, unlike an earlier DM-only version of this bot that needed no
   permissions at all) → open the generated URL and add the bot to a server. A
   channel there is automatically registered on the next poll — within
   `POLL_INTERVAL_MS`, since `syncGuilds()` runs before every poll (see "How it works"
   above).
3. If the bot was added to a server *before* this permission existed, redo step 2's
   authorize flow for that server (same URL, same server) — Discord updates the
   bot's granted permissions in-place, it doesn't require kicking and re-adding it.

The bot never sends or reacts to messages, needs no message-content intent, and needs
**no Gateway intents at all** — it only reads its guild list over REST and posts alerts
directly.

## Auth token: manual refresh only, by design

The API's `guest-login` endpoint requires solving a CAPTCHA, so this bot does not
attempt to log in itself, and never will. Two ways to get a token:

**Manually via DevTools**: open `https://ticket.cineplexbd.com/login`, open DevTools →
Network, log in yourself, and find the Bearer token used on subsequent `get-shows`
requests. Put it in `.env` as `CINEPLEX_AUTH_TOKEN`.

**Via the helper script** (`npm run refresh-token`): opens a real, visible Chromium
window on your machine at the login page. You log in and solve the CAPTCHA yourself,
same as any human visitor. The script just watches your own browser's outgoing
requests to the Cineplex API and copies the `Authorization` and `device-key` header
values it sees into `.env` once you're logged in — it never touches `guest-login` or
the CAPTCHA itself. Requires `playwright` (`npm install`, then once:
`npx playwright install chromium`). It only runs on-demand, when you choose to; it's
not part of the recurring poll loop.

When the token expires, the bot detects the 401 and posts a Discord warning asking you
to run `npm run refresh-token` (or repeat the manual DevTools steps), then restart the
process — it will not try to get a new one on its own.

If the real header name isn't `Authorization: Bearer <token>`, override it with
`CINEPLEX_AUTH_HEADER_NAME` in `.env` to match what DevTools shows (the helper script
detects and writes this automatically).

## Movie name lookup token: manual, and separate from the ticket auth

The movie being watched (`MOVIE_ID`/`MOVIE_NAME`, used in Discord messages instead of
the raw id) is hardcoded in `src/config.ts` — not read from env — so there's exactly one
source of truth and the id/name can't drift out of sync with each other. To find the
name for a movie id (e.g. when switching movies), query cineplexbd.com's public
movie-list API, which needs its own Bearer token, unrelated to the ticket-api auth
above (different host: `cineplex-web-api.cineplexbd.com` vs
`cineplex-ticket-api.cineplexbd.com`):

1. Open <https://www.cineplexbd.com>, DevTools → Network, browse the movie list, find a
   `movie-list` request, and copy its `Authorization` header value into `.env` as
   `CINEPLEX_WEB_API_TOKEN`.
2. `POST` to `https://cineplex-web-api.cineplexbd.com/api/v1/movie-list` with that
   Bearer token (and `appsource: web`) to get back `{"data":{"running":[...],...}}`,
   where each entry has `movie_id` and `title` — match on `movie_id` and copy the
   `title` into `MOVIE_NAME` in `src/config.ts`.

Like the ticket auth, this token is refreshed manually (repeat the DevTools steps above)
whenever it expires — there's no automated refresh script for it, since it's only ever
needed once per movie switch, not on a recurring poll.

When switching movies, also update `SHOW_DATE`/`LOCATION` in `src/config.ts` — the bot
watches one fixed date/location combo, it doesn't discover dates on its own (see "How
it works" above).

## Response schema: confirmed

`get-shows` (called every poll with the fixed `{location, movieId, showDate}` from
`src/config.ts`) returns `{"status":"success","code":200,"data":[...]}` where `data`
is a list of screenings — confirmed shape is `{"locId":2,"movieId":1705,
"movieTitle":"...","showDate":"2026-07-28","screenTitle":"Hall 1",
"showTimes":[{"showTime":"11:20:00","seatPrices":[{"seatTypeTitle":"Regular",
"unitPrice":400}, ...]}, ...]}`. `data` is `[]` when nothing is on sale yet for that
date/location (e.g. movie 1688 is still "Coming Soon" as of this writing).
`formatShowSessions()` in `discordNotifier.ts` turns each showtime into a line like
`2026-07-28 Hall 1 11:20:00 (Regular ৳400, Premium ৳450)` — reading the date straight
off each screening object, not off a separate discovery call — falling back to raw
JSON for a screening that doesn't match this shape. `showtimeDiff.ts` fingerprints the
whole screening entry regardless of schema, so a genuinely new session (e.g. a new
showtime added to the watched date) is what triggers an alert.

## State persistence: Postgres

`src/db.ts` holds one shared connection pool (`DATABASE_URL`), used by all three:

- `src/stateStore.ts` — global state in a single-row `poll_state` table; currently
  just the one-time auth-alert flag.
- `src/channelStore.ts` — registered alert channels in a `discord_channels` table
  (`guild_id`, `channel_id`, `fingerprints`, `has_polled_before`, `added_at`). The
  seen-session fingerprints live here, per channel, rather than globally — see "How
  it works" above for why.
- `src/pollLock.ts` — a single-row `poll_lock` table (`holder_id`, `expires_at`,
  `next_poll_at`) that is both the mutex and the clock for the Vercel HTTP endpoint.
  Unused by `src/index.ts`.

All tables are created automatically on first connect via `CREATE TABLE IF NOT
EXISTS` — no manual migration step. `index.ts` closes the shared pool explicitly on
shutdown (SIGINT/SIGTERM); on Vercel the pool is left open on purpose so warm
instances reuse it, capped at 2 connections per instance since instances multiply.
**`DATABASE_URL` must point at a pooled endpoint on Vercel** (Neon's pooler host,
Supabase's pgbouncer port) — direct connections will exhaust the database's limit as
instances scale.

## Running

- Local dev: `npm install && npm run dev`
- Local prod: `npm run build && npm start`
- Typecheck everything including `api/`: `npm run typecheck` (the default `npm run
  build` compiles `src/` only — Vercel builds `api/` with its own toolchain)
- Refresh the auth token: `npm run refresh-token` (see above — needs
  `npx playwright install chromium` once first)

Locally there's no scheduler or cron involved — `npm start` (or `npm run dev`) runs
the whole thing: it stays running and paces its own polling via `POLL_INTERVAL_MS`.

## Deployment: Vercel

Vercel has no long-running processes: every function is request-scoped and killed at
`maxDuration`. So `api/poll.ts` does not loop — **one request runs at most one poll**,
and an external scheduler decides when to call it.

An earlier version of this deployment tried to keep the loop alive by having each
invocation call itself before exiting. **That does not work on Vercel**, and the
failure is worth recording so nobody tries it again: after about five self-referential
hops Vercel rejects the request with `508 INFINITE_LOOP_DETECTED` (the `x-vercel-id`
trace shows the chain depth, e.g. `bom1:iad1:iad1:iad1:iad1:iad1`). It is deliberate
anti-recursion protection, not a timeout or a transient error, and no budget or timing
change avoids it. A trigger has to originate outside the deployment.

What `api/poll.ts` does per request:

1. Authenticates against `POLL_SECRET` (constant-time compare). Unauthenticated
   callers get `401`.
2. Takes the `poll_lock` mutex in a single atomic `INSERT … ON CONFLICT DO UPDATE …
   WHERE expires_at < now()`. If another invocation is mid-poll it returns
   `{"status":"busy"}` rather than polling on top of it and double-posting.
3. If `next_poll_at` is still in the future, returns `{"status":"not-due", dueInMs}`
   without calling Cineplex at all. **This makes the endpoint safe to trigger at any
   frequency** — the effective cadence stays `POLL_INTERVAL_MS` even if the scheduler
   fires more often, so the two don't have to match exactly.
4. Otherwise syncs guilds, polls, alerts, persists state, sets the next due time, and
   returns `{"status":"polled"}`. Always releases the lock.

### Setup

1. Import the repo on Vercel. `vercel.json` sets the build command, the output
   directory (`public/`, a placeholder page — the project has no real frontend, and
   Vercel fails the deploy without one) and `maxDuration: 30`.
2. Set every variable from `.env.example` in the project, including `POLL_SECRET` and
   a **pooled** `DATABASE_URL`.
3. Point a scheduler at the endpoint. Nothing polls until you do:

   ```
   curl -X POST -H "Authorization: Bearer $POLL_SECRET" https://<app>.vercel.app/api/poll
   ```

   Options, in rough order of fit: a free external pinger (cron-job.org, UptimeRobot)
   set to roughly `POLL_INTERVAL_MS`; Vercel Cron via a `crons` entry in `vercel.json`
   — but Hobby only fires **once per day**, so that needs Pro to be useful here; or a
   real cron entry on any machine you already keep running.

### Trade-offs of this design

- **Nothing polls unless something triggers it.** There is no self-starting behaviour,
  by design. If the scheduler stops, the bot silently stops watching — check
  `/api/status` (below) rather than inferring from Discord being quiet.
- **Cadence granularity is the scheduler's**, not `POLL_INTERVAL_MS`'s.
  `POLL_INTERVAL_MS` can only slow polling down relative to the trigger, never speed it
  up.
- **Join/kick detection is delayed** by up to one poll interval, since guild sync is
  REST polling rather than Gateway events.
- If you would rather not depend on an external trigger at all, `src/index.ts` still
  runs the whole thing as one always-on process on any host that allows it.

## Checking it is still alive

`GET /api/status` — no auth, safe to bookmark:

```json
{
  "healthy": true,
  "watching": { "movie": "…", "movieId": 1688, "showDate": "2026-07-31", "location": 2 },
  "lastPoll": { "at": "…Z", "minutesAgo": 3, "status": "ok", "sessionsOnSale": 0 },
  "nextPollDueAt": "…Z",
  "pollIntervalMinutes": 10,
  "alertChannels": 2,
  "authTokenExpired": false
}
```

`healthy` goes false after three missed poll intervals. `status` is `ok`,
`auth-error`, or `error`, and is stamped on every *attempt*, so a bot that is running
but failing every poll shows `healthy: true` with `status: "error"` — distinguishable
from one that has stopped entirely. `sessionsOnSale: 0` is the normal pre-release
state; it becoming non-zero is the event the whole bot exists to catch.

Point a pinger's keyword check at `"healthy":true` to be told when it stalls, rather
than finding out on the day tickets drop. Note the timestamps are UTC — Bangladesh is
UTC+6.

## Environment variables

See `.env.example` for the full list and defaults.
