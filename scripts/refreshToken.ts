import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { upsertEnvValues } from "./envFile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const envExamplePath = path.join(projectRoot, ".env.example");

const LOGIN_URL = "https://ticket.cineplexbd.com/login";
const API_HOSTNAME = "cineplex-ticket-api.cineplexbd.com";
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;

interface CapturedCredentials {
  readonly authHeaderName: string;
  readonly authToken: string;
  readonly deviceKey: string;
}

const PLACEHOLDER_TOKEN_VALUES = new Set(["null", "undefined", ""]);

/**
 * Returns true if the given header value is a pre-login placeholder (e.g. the literal
 * string "null" the site sends before you've logged in) rather than a real token.
 */
function isPlaceholderTokenValue(value: string): boolean {
  const normalized = value.replace(/^Bearer\s+/i, "").trim().toLowerCase();
  return PLACEHOLDER_TOKEN_VALUES.has(normalized);
}

/**
 * Ensures a .env file exists at envPath, seeding it from .env.example on first run.
 * Returns nothing.
 */
async function ensureEnvFileExists(): Promise<void> {
  try {
    await fs.access(envPath);
  } catch {
    await fs.copyFile(envExamplePath, envPath);
    console.log(`Created .env from .env.example at ${envPath}`);
  }
}

/**
 * Opens a real, visible Chromium window at the Cineplex login page and waits for you to
 * log in there yourself, including solving the CAPTCHA. Watches outgoing requests to the
 * Cineplex API for the Authorization and device-key headers your own browser session
 * sends, and resolves with them as soon as they're seen. Returns the captured header
 * name and values, or rejects if nothing is captured within CAPTURE_TIMEOUT_MS.
 */
async function captureCredentialsFromBrowser(): Promise<CapturedCredentials> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Opening a browser window for you to log in...");
  console.log(`-> ${LOGIN_URL}`);
  console.log("Complete the login yourself in that window, including the CAPTCHA.");
  console.log("This script will pick up your session token automatically once you're logged in.\n");

  await page.goto(LOGIN_URL);

  try {
    return await new Promise<CapturedCredentials>((resolve, reject) => {
      let sawPlaceholder = false;
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${CAPTURE_TIMEOUT_MS / 1000}s waiting for login`));
      }, CAPTURE_TIMEOUT_MS);

      context.on("request", (request) => {
        let hostname: string;
        try {
          hostname = new URL(request.url()).hostname;
        } catch {
          return;
        }
        if (hostname !== API_HOSTNAME) {
          return;
        }

        const headers = request.headers();
        const authKey = Object.keys(headers).find((key) => key.toLowerCase() === "authorization");
        const deviceKeyKey = Object.keys(headers).find((key) => key.toLowerCase() === "device-key");
        const authValue = authKey ? headers[authKey] : undefined;
        const deviceKeyValue = deviceKeyKey ? headers[deviceKeyKey] : undefined;

        if (!authKey || !authValue || !deviceKeyKey || !deviceKeyValue) {
          return;
        }

        if (isPlaceholderTokenValue(authValue)) {
          if (!sawPlaceholder) {
            sawPlaceholder = true;
            console.log("(Still waiting for you to finish logging in...)");
          }
          return;
        }

        clearTimeout(timer);
        resolve({
          authHeaderName: authKey,
          authToken: authValue.replace(/^Bearer\s+/i, ""),
          deviceKey: deviceKeyValue,
        });
      });
    });
  } finally {
    await browser.close();
  }
}

/**
 * Entry point: makes sure .env exists, opens a browser for you to log in, captures the
 * resulting auth token and device key from your own session, writes them into .env, and
 * prints next steps. Returns nothing; sets exit code 1 if capture fails or times out.
 */
async function main(): Promise<void> {
  await ensureEnvFileExists();

  try {
    const credentials = await captureCredentialsFromBrowser();

    await upsertEnvValues(envPath, {
      CINEPLEX_AUTH_TOKEN: credentials.authToken,
      CINEPLEX_DEVICE_KEY: credentials.deviceKey,
      CINEPLEX_AUTH_HEADER_NAME: credentials.authHeaderName,
    });

    console.log("\nCaptured a fresh token and wrote it to .env:");
    console.log(`  CINEPLEX_AUTH_HEADER_NAME=${credentials.authHeaderName}`);
    console.log(`  CINEPLEX_DEVICE_KEY=${credentials.deviceKey}`);
    console.log(`  CINEPLEX_AUTH_TOKEN=${credentials.authToken.slice(0, 12)}...`);
    console.log("\nRestart (or redeploy) the bot for the new token to take effect.");
  } catch (error) {
    console.error(
      `\nFailed to capture credentials: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

main();
