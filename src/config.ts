import "dotenv/config";

const MOVIE_ID = 1687;
const MOVIE_NAME = "Billie Eilish: Hit Me Hard and Soft - The Tour Live in 3D";
const SHOW_DATE = "2026-07-28";
const LOCATION = 2;

export interface ChainConfig {
  readonly chainSecret: string;
  readonly selfBaseUrl: string;
  readonly segmentBudgetMs: number;
  readonly leaseTtlMs: number;
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
 * Reads the settings that govern the self-chaining poll loop on Vercel: the shared
 * secret guarding the endpoint, the base URL each segment calls to spawn its
 * successor, how long one segment runs before handing off, and how long its lease
 * stays valid without renewal. `selfBaseUrl` falls back to Vercel's own deployment
 * URL variables, preferring the stable production domain so a chain doesn't pin
 * itself to a superseded deployment. Returns a typed ChainConfig. Throws if
 * CHAIN_SECRET is missing or if no base URL can be determined.
 */
export function loadChainConfig(): ChainConfig {
  const explicitBaseUrl = process.env.PUBLIC_BASE_URL;
  const vercelBaseUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  const selfBaseUrl = explicitBaseUrl ?? (vercelBaseUrl ? `https://${vercelBaseUrl}` : undefined);

  if (!selfBaseUrl) {
    throw new Error("Cannot determine self URL: set PUBLIC_BASE_URL");
  }

  return {
    chainSecret: requireEnv("CHAIN_SECRET"),
    selfBaseUrl: selfBaseUrl.replace(/\/$/, ""),
    segmentBudgetMs: Number(process.env.CHAIN_SEGMENT_BUDGET_MS ?? "45000"),
    leaseTtlMs: Number(process.env.CHAIN_LEASE_TTL_MS ?? "90000"),
  };
}
