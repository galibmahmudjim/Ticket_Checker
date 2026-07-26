import { promises as fs } from "node:fs";
import path from "node:path";

interface PersistedState {
  readonly fingerprints: readonly string[];
  readonly lastAuthAlertAt: number;
}

export interface PollState {
  readonly fingerprints: ReadonlySet<string>;
  readonly hasPolledBefore: boolean;
  readonly lastAuthAlertAt: number;
}

/**
 * Reads the persisted poll state from disk at stateFilePath.
 * Returns { fingerprints, lastAuthAlertAt, hasPolledBefore: true } if a state file
 * already exists (even with zero fingerprints, meaning a prior poll found no
 * showtimes), or a zeroed-out state with hasPolledBefore: false if this is the very
 * first run (whether that's the first-ever run of a long-lived process, or the
 * first-ever GitHub Actions invocation). Rethrows any filesystem error other than
 * "file not found".
 */
export async function loadState(stateFilePath: string): Promise<PollState> {
  try {
    const raw = await fs.readFile(stateFilePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      fingerprints: new Set(parsed.fingerprints),
      hasPolledBefore: true,
      lastAuthAlertAt: parsed.lastAuthAlertAt ?? 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { fingerprints: new Set(), hasPolledBefore: false, lastAuthAlertAt: 0 };
    }
    throw error;
  }
}

/**
 * Writes the given poll state to stateFilePath as JSON, creating parent directories
 * as needed. Returns nothing; this becomes the new baseline for the next poll
 * (whether the next loop iteration in-process, or the next GitHub Actions run).
 */
export async function saveState(stateFilePath: string, state: PollState): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
  const payload: PersistedState = {
    fingerprints: [...state.fingerprints],
    lastAuthAlertAt: state.lastAuthAlertAt,
  };
  await fs.writeFile(stateFilePath, JSON.stringify(payload, null, 2), "utf-8");
}
