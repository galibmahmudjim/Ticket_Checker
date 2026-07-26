export type LogLevel = "info" | "warn" | "error";

/**
 * Writes a single structured, timestamped log line to stdout/stderr.
 * Returns nothing; routes "error"/"warn" to console.error/console.warn and everything else to console.log.
 * Centralizes logging so call sites never call console.* directly.
 */
export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
