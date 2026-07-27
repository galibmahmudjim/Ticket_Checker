# moviebot

Discord alert bot that polls Cineplex Bangladesh's ticket API and DMs you directly
when a new showtime/ticket becomes available for a specific movie, at a fixed
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
  the previous poll's fingerprints (persisted via `src/stateStore.ts` to a `poll_state`
  table in Postgres, `DATABASE_URL`) to find genuinely new sessions (e.g. a showtime
  just went on sale for the watched date). The table is created automatically on
  first connect — no manual migration needed.
- `src/discordGateway.ts` connects to Discord's Gateway (`GatewayIntentBits.Guilds`
  only — not a privileged intent, no portal toggle needed) purely to detect which
  servers the bot is a member of. Whenever a server's owner becomes known — both
  already-joined servers (checked once at startup) and newly-joined ones (via the
  `guildCreate` event) — they're registered as an alert recipient via
  `src/recipientStore.ts`, in a `discord_recipients` table in Postgres (auto-created,
  same as `poll_state`). No manual user-id configuration: adding the bot to a server
  is what makes its owner start receiving alerts.
- `src/discordNotifier.ts` opens a DM channel with every registered recipient via the
  bot's REST API (`DISCORD_BOT_TOKEN`) and posts the same message to each one
  independently — one recipient's failure doesn't block delivery to the others. Also
  sends a separate warning message if the auth token expires — sent once per failure
  episode (tracked via `state.authAlertSent`), not repeated on every poll, and reset
  once a poll succeeds again so a future failure alerts again.
- `src/pollCycle.ts` holds the "do one poll" logic (fetch → diff → look up current
  recipients → alert → return updated state).
- `src/index.ts` is the only entry point: loads config, connects the Discord Gateway,
  sends a one-time "bot started" DM to whoever's already registered, then loops
  forever on `POLL_INTERVAL_MS` calling `runPollCycle`, persisting state after every
  cycle. No cron/scheduler involved — the process itself stays running, keeps the
  Gateway connection open, and paces its own polling via `setTimeout`.

## Discord DM setup

Webhooks can only post into server channels, not personal DMs, so this needs an
actual bot application:

1. <https://discord.com/developers/applications> → New Application → **Bot** tab →
   Reset Token → copy it into `.env` as `DISCORD_BOT_TOKEN`.
2. Same app → **OAuth2** → URL Generator → scope `bot` (no permissions needed) → open
   the generated URL and add the bot to a server. That server's owner is automatically
   registered as a recipient the next time the bot process starts (or immediately, if
   it's already running) — see "How it works" above. To add another recipient, add
   the bot to another server they own; there's currently no way to register anyone
   other than a server's owner (e.g. a regular member) without extending
   `discordGateway.ts`/`recipientStore.ts` further.

The bot posts nothing in any server itself, and doesn't need any message-related
intents — it only watches for guild membership changes and DMs recipients directly.

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

`src/db.ts` holds one shared connection pool (`DATABASE_URL`), used by both:

- `src/stateStore.ts` — poll state (fingerprints of seen sessions, and the one-time
  auth-alert flag) in a single-row `poll_state` table.
- `src/recipientStore.ts` — registered Discord recipients in a `discord_recipients`
  table (`user_id`, `guild_id`, `added_at`).

Both tables are created automatically on first connect via `CREATE TABLE IF NOT
EXISTS` — no manual migration step. `index.ts` closes the shared pool explicitly on
shutdown (SIGINT/SIGTERM).

## Running

- Local dev: `npm install && npm run dev`
- Local prod: `npm run build && npm start`
- Refresh the auth token: `npm run refresh-token` (see above — needs
  `npx playwright install chromium` once first)

There's no scheduler, cron job, or container involved by design — `npm start` (or
`npm run dev`) runs the whole thing: it stays running and paces its own polling via
`POLL_INTERVAL_MS`. Keep the process alive on whatever machine you choose to run it
on for as long as you want it watching.

## Environment variables

See `.env.example` for the full list and defaults.
