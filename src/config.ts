import "dotenv/config";

const MOVIE_ID = 1687;
const MOVIE_NAME = "Billie Eilish: Hit Me Hard and Soft - The Tour Live in 3D";
const SHOW_DATE = "2026-07-28";
const LOCATION = 2;

export interface EndpointConfig {
  readonly pollSecret: string;
  readonly lockTtlMs: number;
}

export interface AppConfig {
  readonly movieId: number;
  readonly movieName: string;
  readonly showDate: string;
  readonly location: number;
  readonly cineplexBaseUrl: string;
  readonly appSource: string;
  readonly deviceKey: string;
  readonly authToken: string;
  readonly authHeaderName: string;
  readonly discordBotToken: string;
  readonly pollIntervalMs: number;
  readonly databaseUrl: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Reads and validates environment variables into a typed config object.
 * Returns an AppConfig with all values the bot needs to poll Cineplex and post to Discord.
 * Throws if a required variable (auth token, bot token, user id) is missing.
 */
export function loadConfig(): AppConfig {
  return {
    movieId: MOVIE_ID,
    movieName: MOVIE_NAME,
    showDate: SHOW_DATE,
    location: LOCATION,
    cineplexBaseUrl:
      process.env.CINEPLEX_BASE_URL ?? "https://cineplex-ticket-api.cineplexbd.com/api/v1",
    appSource: process.env.CINEPLEX_APPSOURCE ?? "web",
    deviceKey: requireEnv("CINEPLEX_DEVICE_KEY"),
    authToken: requireEnv("CINEPLEX_AUTH_TOKEN"),
    authHeaderName: process.env.CINEPLEX_AUTH_HEADER_NAME ?? "Authorization",
    discordBotToken: requireEnv("DISCORD_BOT_TOKEN"),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "60000"),
    databaseUrl: requireEnv("DATABASE_URL"),
  };
}

/**
 * Reads the settings that govern the HTTP poll endpoint: the shared secret callers
 * must present, and how long the poll lock stays valid so a crashed invocation can't
 * block the next trigger indefinitely. Returns a typed EndpointConfig. Throws if
 * POLL_SECRET is missing. Only used by `api/poll.ts`; the long-running entry point in
 * `src/index.ts` needs none of it.
 */
export function loadEndpointConfig(): EndpointConfig {
  return {
    pollSecret: requireEnv("POLL_SECRET"),
    lockTtlMs: Number(process.env.POLL_LOCK_TTL_MS ?? "60000"),
  };
}
