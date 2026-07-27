import "dotenv/config";

const MOVIE_ID = 1688;
const MOVIE_NAME = "Spider-Man: Brand New Day";

export interface AppConfig {
  readonly movieId: number;
  readonly movieName: string;
  readonly cineplexBaseUrl: string;
  readonly appSource: string;
  readonly deviceKey: string;
  readonly authToken: string;
  readonly authHeaderName: string;
  readonly discordBotToken: string;
  readonly discordUserId: string;
  readonly pollIntervalMs: number;
  readonly stateFilePath: string;
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
    cineplexBaseUrl:
      process.env.CINEPLEX_BASE_URL ?? "https://cineplex-ticket-api.cineplexbd.com/api/v1",
    appSource: process.env.CINEPLEX_APPSOURCE ?? "web",
    deviceKey: requireEnv("CINEPLEX_DEVICE_KEY"),
    authToken: requireEnv("CINEPLEX_AUTH_TOKEN"),
    authHeaderName: process.env.CINEPLEX_AUTH_HEADER_NAME ?? "Authorization",
    discordBotToken: requireEnv("DISCORD_BOT_TOKEN"),
    discordUserId: requireEnv("DISCORD_USER_ID"),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "60000"),
    stateFilePath: process.env.STATE_FILE_PATH ?? "./data/state.json",
  };
}
