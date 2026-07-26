import { stat } from "node:fs/promises";

const heartbeatPath = process.env.HEARTBEAT_FILE_PATH ?? "./data/heartbeat";
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "60000");
const staleAfterMs = pollIntervalMs * 3;

try {
  const stats = await stat(heartbeatPath);
  const ageMs = Date.now() - stats.mtimeMs;
  process.exit(ageMs <= staleAfterMs ? 0 : 1);
} catch {
  process.exit(1);
}
