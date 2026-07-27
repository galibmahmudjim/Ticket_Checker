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
  first connect — no manual migration needed. Postgres persistence means state works
  identically across every hosting option (local/Docker/GitHub Actions/Vercel), unlike
  the old file-based approach, which needed a persistent disk (Docker volume) or a
  git-commit-back trick (GitHub Actions) and wouldn't have worked on Vercel at all.
- `src/discordNotifier.ts` opens a DM channel with `DISCORD_USER_ID` via the bot's
  REST API (`DISCORD_BOT_TOKEN`) and posts a message there when new sessions appear,
  and a separate warning message if the auth token expires — sent once per failure
  episode (tracked via `state.authAlertSent`), not repeated on every poll, and reset
  once a poll succeeds again so a future failure alerts again. No gateway connection —
  just one-off REST calls, since we're only ever sending, never listening.
- `src/pollCycle.ts` holds the shared "do one poll" logic (fetch → diff → alert →
  return updated state) used by both entry points below.
- `src/index.ts` is the long-lived entry point (local/Docker): loads config, sends a
  one-time "bot started" DM, then loops on `POLL_INTERVAL_MS` calling `runPollCycle`.
- `src/runOnce.ts` is the single-shot entry point (GitHub Actions cron): runs
  `runPollCycle` exactly once and exits. No startup DM (would spam on every cron run).

## Discord DM setup

Webhooks can only post into server channels, not personal DMs, so this needs an
actual bot application:

1. <https://discord.com/developers/applications> → New Application → **Bot** tab →
   Reset Token → copy it into `.env` as `DISCORD_BOT_TOKEN`.
2. Same app → **OAuth2** → URL Generator → scope `bot` (no permissions needed) → open
   the generated URL and add the bot to any server you're also a member of (a private
   server with just you is fine — the bot only needs to share *a* server with you;
   Discord requires that before a bot can DM someone).
3. In Discord, enable **Developer Mode** (User Settings → Advanced), then right-click
   your own name/avatar anywhere → **Copy User ID** → put it in `.env` as
   `DISCORD_USER_ID`.

The bot never needs to be online/connected to a gateway and never posts in the
server itself — it only ever opens a DM channel with your user id and sends there.

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
to run `npm run refresh-token` (or repeat the manual DevTools steps) — it will not try
to get a new one on its own.

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

## Running

- Local dev: `npm install && npm run dev`
- Local prod build: `npm run build && npm start`
- Docker: `docker compose up -d --build` (reads `.env`; the `moviebot-data` volume
  only holds the heartbeat file now, not state — state lives in Postgres)
- One-shot (for GitHub Actions or manual testing): `npm run build && npm run run-once`
- Refresh the auth token: `npm run refresh-token` (see above — needs
  `npx playwright install chromium` once first)

## Running on GitHub Actions instead of Vercel/Docker

Vercel's Hobby-tier cron jobs are capped at once/day, too infrequent for ticket
alerts, so this repo can instead run as a GitHub Actions scheduled workflow
(`.github/workflows/poll-tickets.yml`), polling every 5 minutes via `npm run run-once`
(GitHub's practical minimum cron interval is ~5 minutes; schedules can also be delayed
under high platform load — in practice, GitHub throttles frequent schedules well
beyond that documented floor, often down to roughly hourly, especially on low-traffic
repos; and GitHub auto-disables a scheduled workflow after 60 days with zero commits
to the repo — re-enable manually via the Actions tab's "Run workflow" button, or from
GitHub CLI, if that ever happens).

Since state lives in Postgres (`DATABASE_URL`), GitHub Actions runners being ephemeral
doesn't matter — no git-commit-back step needed (unlike the old file-based approach),
so `permissions: contents: write` was removed from the workflow.

Setup:

1. Push this repo to GitHub (private or public, doesn't matter — no state file gets
   committed to it anymore).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `CINEPLEX_DEVICE_KEY`
   - `CINEPLEX_AUTH_TOKEN`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_USER_ID`
   - `DATABASE_URL`
   (Never commit these — the workflow only ever references them as `${{ secrets.X }}`.)
3. The workflow runs automatically on its schedule once merged to the default branch,
   or trigger it immediately via the **Actions** tab → "Poll Cineplex tickets" →
   **Run workflow**.
4. When `CINEPLEX_AUTH_TOKEN` expires, you'll get the same Discord warning DM as
   local/Docker mode — refresh it locally with `npm run refresh-token`, then update
   the `CINEPLEX_AUTH_TOKEN` (and `CINEPLEX_DEVICE_KEY`, if it also changed) repo
   secret with the new value.

## State persistence: Postgres, works everywhere

`src/stateStore.ts` stores poll state (fingerprints of seen sessions, and the
one-time auth-alert flag) in a single-row `poll_state` table, created automatically
on first connect via `CREATE TABLE IF NOT EXISTS` — no manual migration step. This
replaced an earlier file-based approach (`data/state.json` locally, `state.json`
committed back to the repo on GitHub Actions) specifically so the same code works
unchanged across local/Docker/GitHub Actions/Vercel — Vercel serverless functions
have no persistent filesystem between invocations, so file-based state wouldn't have
survived there. `runOnce.ts` calls `process.exit(0)` after finishing since an open
Postgres connection pool would otherwise keep the process alive; `index.ts` closes
the pool explicitly on shutdown instead, since it needs the connection to stay open
across its in-process loop.

## Running on Vercel instead of GitHub Actions

`api/poll.ts` is a Vercel serverless function equivalent to `runOnce.ts` — runs one
poll cycle and returns an HTTP response instead of exiting a process, since Vercel
Cron triggers a URL rather than a script. `vercel.json` schedules it via `crons`. This
only works because state lives in Postgres now (see above) — Vercel functions have no
persistent local disk between invocations, so the old file-based state store couldn't
have survived here.

Setup:

1. Import this repo into Vercel (vercel.com → New Project → pick the GitHub repo).
2. Project → **Settings → Environment Variables**, add the same values as `.env.example`
   (`CINEPLEX_DEVICE_KEY`, `CINEPLEX_AUTH_TOKEN`, `CINEPLEX_AUTH_HEADER_NAME`,
   `DISCORD_BOT_TOKEN`, `DISCORD_USER_ID`, `DATABASE_URL`), plus a `CRON_SECRET` you
   make up (any random string) — Vercel automatically sends it as
   `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests, and `api/poll.ts`
   rejects any request that doesn't carry it, so the endpoint can't be triggered by
   anyone who finds the URL.
3. Deploy. Vercel registers the cron schedule from `vercel.json` automatically.
4. **Vercel Hobby's cron cap is once/day** — `*/5 * * * *` in `vercel.json` needs
   Vercel Pro to actually run that often; Hobby will reject or silently downgrade it.
5. When `CINEPLEX_AUTH_TOKEN` expires, you'll get the same Discord warning DM as
   other modes — refresh it locally with `npm run refresh-token`, then update the
   `CINEPLEX_AUTH_TOKEN` (and `CINEPLEX_DEVICE_KEY`, if it also changed) in Vercel's
   environment variables and redeploy (or just wait for the next cron tick to pick up
   the updated env var, if Vercel applies it without a redeploy).

If you switch to Vercel, disable or delete `.github/workflows/poll-tickets.yml` —
running both schedulers polls Cineplex twice as often for no benefit (Postgres-backed
fingerprinting prevents duplicate alerts either way, but it's still pointless
duplication).

## Environment variables

See `.env.example` for the full list and defaults.
