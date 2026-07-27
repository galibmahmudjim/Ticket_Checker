import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

interface CineplexApiResponse {
  readonly status: "success" | "error";
  readonly code: number;
  readonly data: unknown;
  readonly message: readonly string[] | null;
}

/**
 * Thrown when Cineplex responds with an authentication failure (expired/invalid token).
 * Carries the API's message so callers can log/alert with the original reason.
 */
export class CineplexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CineplexAuthError";
  }
}

/**
 * POSTs to the given Cineplex ticket-api endpoint with the configured auth token and
 * device headers. Returns the parsed `data` field of the response. Throws
 * CineplexAuthError on a 401/"Unauthenticated" response, or a generic Error for any
 * other API-level or network failure.
 */
async function callCineplexApi(
  config: AppConfig,
  endpoint: string,
  requestBody: Record<string, unknown>,
): Promise<unknown> {
  const authHeaderValue =
    config.authHeaderName.toLowerCase() === "authorization"
      ? `Bearer ${config.authToken}`
      : config.authToken;

  const url = `${config.cineplexBaseUrl}/${endpoint}`;

  log("info", "Cineplex API request", {
    url,
    method: "POST",
    body: requestBody,
    headers: {
      appsource: config.appSource,
      "device-key": config.deviceKey,
      [config.authHeaderName]: `${authHeaderValue.slice(0, 15)}...`,
    },
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      appsource: config.appSource,
      "device-key": config.deviceKey,
      [config.authHeaderName]: authHeaderValue,
    },
    body: JSON.stringify(requestBody),
  });

  const json = (await response.json()) as CineplexApiResponse;

  log("info", "Cineplex API response", {
    httpStatus: response.status,
    body: json,
  });

  const message = json.message?.join(" ") ?? "";

  if (response.status === 401 || /unauthenticated/i.test(message)) {
    throw new CineplexAuthError(message || "Unauthenticated");
  }

  if (json.status === "error") {
    throw new Error(`Cineplex API error (${json.code}): ${message || "unknown error"}`);
  }

  return json.data;
}

/**
 * Calls the Cineplex get-showdate endpoint for the configured movie. Returns the raw
 * list of showdate entries (empty array if none). Throws CineplexAuthError on auth
 * failure, or a generic Error for any other API-level or network failure.
 */
export async function fetchShowdates(config: AppConfig): Promise<readonly unknown[]> {
  const data = await callCineplexApi(config, "get-showdate", { movie_id: config.movieId });
  return Array.isArray(data) ? data : [];
}

/**
 * Calls the Cineplex get-shows endpoint for one specific showdate entry (location +
 * movieId + showDate) to fetch the actual show sessions (times, halls, etc.) on sale
 * for that date. Returns the raw `data` value as-is — its exact shape isn't confirmed
 * yet, so callers should treat it schema-agnostically. Throws CineplexAuthError on
 * auth failure, or a generic Error for any other API-level or network failure.
 */
export async function fetchShows(
  config: AppConfig,
  entry: { readonly location: unknown; readonly movieId: unknown; readonly showDate: unknown },
): Promise<unknown> {
  return callCineplexApi(config, "get-shows", {
    location: entry.location,
    movieId: entry.movieId,
    showDate: entry.showDate,
  });
}
