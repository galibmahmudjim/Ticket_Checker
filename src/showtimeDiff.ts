/**
 * Serializes any value into a string with object keys sorted, so two structurally
 * identical objects always produce the same string regardless of key order.
 * Returns that string; used as a stable fingerprint input for diffing API entries.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Produces a stable string fingerprint for one showdate/showtime entry returned by the API.
 * Returns the same string for structurally identical entries, regardless of key order,
 * so entries can be compared across polls without knowing the exact schema.
 */
export function fingerprintShowEntry(entry: unknown): string {
  return stableStringify(entry);
}

export interface DiffResult {
  readonly newEntries: readonly unknown[];
  readonly allFingerprints: ReadonlySet<string>;
}

/**
 * Compares the latest list of showdate entries against the set of fingerprints seen on
 * previous polls. Returns the subset of entries not present in `seenFingerprints`
 * (newEntries) plus the full fingerprint set for the current poll (allFingerprints),
 * which the caller persists as the new baseline.
 */
export function findNewEntries(
  entries: readonly unknown[],
  seenFingerprints: ReadonlySet<string>,
): DiffResult {
  const allFingerprints = new Set<string>();
  const newEntries: unknown[] = [];

  for (const entry of entries) {
    const fingerprint = fingerprintShowEntry(entry);
    allFingerprints.add(fingerprint);
    if (!seenFingerprints.has(fingerprint)) {
      newEntries.push(entry);
    }
  }

  return { newEntries, allFingerprints };
}
