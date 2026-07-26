import { promises as fs } from "node:fs";

const ENV_KEY_PATTERN = /^([A-Z0-9_]+)=/;

/**
 * Updates (or appends) the given key/value pairs in the .env file at envPath, leaving
 * every other line untouched. Creates the file if it doesn't exist yet.
 * Returns nothing.
 */
export async function upsertEnvValues(
  envPath: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const lines = content.length > 0 ? content.split("\n") : [];
  const remainingKeys = new Set(Object.keys(values));

  const updatedLines = lines.map((line) => {
    const match = ENV_KEY_PATTERN.exec(line);
    const key = match?.[1];
    if (key !== undefined && remainingKeys.has(key)) {
      remainingKeys.delete(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });

  for (const key of remainingKeys) {
    updatedLines.push(`${key}=${values[key]}`);
  }

  await fs.writeFile(envPath, updatedLines.join("\n"), "utf-8");
}
