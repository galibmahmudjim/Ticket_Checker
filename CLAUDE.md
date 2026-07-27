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
  - `api/poll.ts` — used on Vercel. One HTTP request runs a *segment* of the loop, then
    calls itself to spawn the next. See "Deployment: Vercel" below.
  - `src/index.ts` — used by `npm run dev` / `npm start` locally, and by any always-on
    host. Loops forever on `POLL_INTERVAL_MS` via `setTimeout`, pacing itself in
    process. Not used on Vercel at all.

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
- `src/chainLease.ts` — a single-row `poll_chain` table (`runner_id`,
  `lease_expires_at`, `next_poll_at`) that is both the lock and the clock for the
  Vercel self-chaining loop. Unused by `src/index.ts`.

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

## Deployment: Vercel (self-chaining loop)

Vercel has no long-running processes: every function is request-scoped and killed at
`maxDuration`. Rather than a cron job, this deployment keeps polling alive by having
each invocation **spawn its successor** before it exits, so the loop is a chain of
HTTP requests instead of one process.

`api/poll.ts` handles one link in that chain:

1. Authenticates the request against `CHAIN_SECRET` (constant-time compare).
2. Claims the `poll_chain` lease in a single atomic `INSERT … ON CONFLICT DO UPDATE
   … WHERE lease_expires_at < now()`. Exactly one of any number of concurrent requests
   wins; the losers return `200 {"status":"already-running"}` and do nothing. This is
   what stops a duplicate chain from forming and double-posting every alert.
3. Responds `202` immediately, then keeps working via `waitUntil` from
   `@vercel/functions`.
4. `src/chainRunner.ts` polls until `CHAIN_SEGMENT_BUDGET_MS` is nearly spent, renewing
   the lease each iteration and bailing out if it's ever lost. Cadence comes from the
   persisted `next_poll_at`, not a fixed sleep, so the real interval stays at
   `POLL_INTERVAL_MS` across segment boundaries instead of resetting on every handoff.
5. Releases the lease, **then** POSTs to `/api/poll` to start the next segment. The
   order matters: if the lease were still held, the successor would see the chain as
   running, exit, and the chain would die.

Setup:

1. Import the repo on Vercel. No build settings needed — `vercel.json` sets
   `maxDuration: 60` for `api/poll.ts`.
2. Set every variable from `.env.example` in the Vercel project, including
   `CHAIN_SECRET` and a **pooled** `DATABASE_URL`.
3. Start the chain once by hand — nothing starts it automatically:
   `curl -X POST -H "Authorization: Bearer $CHAIN_SECRET" https://<app>.vercel.app/api/poll`

### Known limits of this approach

These are inherent to running a loop on serverless, not bugs:

- **A broken chain stays broken.** If a segment is killed mid-flight (deploy, platform
  error, timeout overrun), nothing restarts it. The endpoint is idempotent, so any
  request to `/api/poll` revives it — hit it manually, or point a free external uptime
  pinger at it as a watchdog. Look for `CHAIN BROKEN` in the function logs.
- **Compute burns continuously.** The function is billed while sleeping between polls,
  24/7 — unlike cron, which bills only per tick. Raising `POLL_INTERVAL_MS` does not
  reduce cost here; it just idles more.
- **A deploy orphans the running chain.** The in-flight segment finishes against the
  old code and hands off to whatever `PUBLIC_BASE_URL` resolves to. Restart the chain
  manually after deploying if you want the new code polling immediately.
- **Join/kick detection is delayed** by up to one poll interval, since it's REST
  polling rather than Gateway events.

## Environment variables

See `.env.example` for the full list and defaults.
