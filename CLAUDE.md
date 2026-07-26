# moviebot

Discord alert bot that polls Cineplex Bangladesh's ticket API and DMs you directly
when a new showtime/ticket becomes available for a specific movie.

## How it works

- `src/cineplexClient.ts` calls `POST {CINEPLEX_BASE_URL}/get-showdate` with
  `movie_id`, plus `appsource` / `device-key` headers and a Bearer auth token.
- `src/showtimeDiff.ts` fingerprints each returned showdate entry and diffs against
  the previous poll's fingerprints (persisted via `src/stateStore.ts` to
  `STATE_FILE_PATH`) to find genuinely new entries.
- `src/discordNotifier.ts` opens a DM channel with `DISCORD_USER_ID` via the bot's
  REST API (`DISCORD_BOT_TOKEN`) and posts a message there when new entries appear,
  and a separate warning message if the auth token expires. No gateway connection —
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
Network, log in yourself, and find the Bearer token used on subsequent `get-showdate`
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

`CINEPLEX_MOVIE_NAME` (used in Discord messages instead of the raw id) is a static
value in `.env` — the running bot never looks it up itself. To find the name for a
`CINEPLEX_MOVIE_ID` (e.g. when switching movies), query cineplexbd.com's public
movie-list API, which needs its own Bearer token, unrelated to the ticket-api auth
above (different host: `cineplex-web-api.cineplexbd.com` vs
`cineplex-ticket-api.cineplexbd.com`):

1. Open <https://www.cineplexbd.com>, DevTools → Network, browse the movie list, find a
   `movie-list` request, and copy its `Authorization` header value into `.env` as
   `CINEPLEX_WEB_API_TOKEN`.
2. `POST` to `https://cineplex-web-api.cineplexbd.com/api/v1/movie-list` with that
   Bearer token (and `appsource: web`) to get back `{"data":{"running":[...],...}}`,
   where each entry has `movie_id` and `title` — match on `movie_id` and copy the
   `title` into `CINEPLEX_MOVIE_NAME`.

Like the ticket auth, this token is refreshed manually (repeat the DevTools steps above)
whenever it expires — there's no automated refresh script for it, since it's only ever
needed once per movie switch, not on a recurring poll.

## Response schema: confirmed connectivity, entry shape still unseen

With a real token, `get-showdate` returns `{"status":"success","code":200,"data":[],"message":["Request Success"]}`
for movie 1688 — confirmed working, but `data` has been empty every time so far (no
showtimes on sale yet), so the shape of an individual entry once one exists is still
unknown. The diff/format logic in `showtimeDiff.ts` and `discordNotifier.ts` is
written schema-agnostically (fingerprints the whole entry, best-effort extracts
`date`/`time`/`hall`-ish fields) so it should work regardless — but check the first
real alert to confirm entries display sensibly, and adjust the field-name guesses in
`formatShowEntry()` if needed.

## Running

- Local dev: `npm install && npm run dev`
- Local prod build: `npm run build && npm start`
- Docker: `docker compose up -d --build` (reads `.env`, persists state in the
  `moviebot-data` volume)
- One-shot (for GitHub Actions or manual testing): `npm run build && npm run run-once`
- Refresh the auth token: `npm run refresh-token` (see above — needs
  `npx playwright install chromium` once first)

## Running on GitHub Actions instead of Vercel/Docker

Vercel's Hobby-tier cron jobs are capped at once/day, too infrequent for ticket
alerts, so this repo can instead run as a GitHub Actions scheduled workflow
(`.github/workflows/poll-tickets.yml`), polling every 5 minutes via `npm run run-once`
(GitHub's practical minimum cron interval is ~5 minutes; schedules can also be delayed
under high platform load, and GitHub auto-disables a scheduled workflow after 60 days
with zero commits to the repo — re-enable manually via the Actions tab's
"Run workflow" button, or from GitHub CLI, if that ever happens).

Since GitHub Actions runners are ephemeral (nothing persists between runs), state
lives in `state.json` at the repo root (not `data/state.json`, which is
`.gitignore`d for local/Docker use) and the workflow commits it back to the repo after
every run that changes it.

Setup:

1. Push this repo to GitHub (private recommended — the repo will contain
   `state.json`, which is harmless bookkeeping data, but there's no reason to make it
   public unless you want to).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `CINEPLEX_DEVICE_KEY`
   - `CINEPLEX_AUTH_TOKEN`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_USER_ID`
   (Never commit these — the workflow only ever references them as `${{ secrets.X }}`.)
3. The workflow runs automatically on its schedule once merged to the default branch,
   or trigger it immediately via the **Actions** tab → "Poll Cineplex tickets" →
   **Run workflow**.
4. When `CINEPLEX_AUTH_TOKEN` expires, you'll get the same Discord warning DM as
   local/Docker mode — refresh it locally with `npm run refresh-token`, then update
   the `CINEPLEX_AUTH_TOKEN` (and `CINEPLEX_DEVICE_KEY`, if it also changed) repo
   secret with the new value.

## Environment variables

See `.env.example` for the full list and defaults.
