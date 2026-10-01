/**
 * Skylight token cache
 *
 * Persists the OAuth token to disk so that every server process on the machine
 * (Claude Desktop, Cowork, Claude Code, ...) reuses one login instead of each
 * replaying the email/password form on startup. Repeated form logins are what
 * trip Skylight's Cloudflare bot protection (HTTP 403 block page).
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CachedToken {
  email: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, if the server told us. */
  expiresAt?: number;
  subscriptionStatus: string | null;
  /** Epoch ms when this token was obtained. */
  savedAt: number;
}

/** Treat tokens as expired this long before their real expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** A lock file older than this is assumed abandoned by a crashed process. */
const STALE_LOCK_MS = 2 * 60 * 1000;
const LOCK_POLL_MS = 500;

export function getTokenCachePath(): string {
  return process.env.SKYLIGHT_TOKEN_CACHE || join(homedir(), ".skylight-mcp", "token.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTokenUsable(token: CachedToken, now = Date.now()): boolean {
  return !!token.accessToken && (token.expiresAt === undefined || token.expiresAt - EXPIRY_SKEW_MS > now);
}

export async function readCachedToken(email: string, path = getTokenCachePath()): Promise<CachedToken | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CachedToken;
    if (!parsed.accessToken || parsed.email?.toLowerCase() !== email.toLowerCase()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCachedToken(token: CachedToken, path = getTokenCachePath()): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(token, null, 2);
    const tmpPath = `${path}.${process.pid}.tmp`;
    await writeFile(tmpPath, data, { mode: 0o600 });
    try {
      await rename(tmpPath, path);
    } catch {
      // Windows can refuse the rename while another process has the file open.
      await writeFile(path, data, { mode: 0o600 });
      await rm(tmpPath, { force: true });
    }
  } catch (error) {
    console.error(`[auth] Could not write token cache at ${path}: ${(error as Error).message}`);
  }
}

/**
 * Remove the cached token, but only if it is still the one we were using
 * (another process may already have replaced it with a fresh one).
 */
export async function clearCachedToken(accessToken: string, path = getTokenCachePath()): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CachedToken;
    if (parsed.accessToken === accessToken) {
      await rm(path, { force: true });
    }
  } catch {
    // Nothing cached.
  }
}

/**
 * Run fn while holding a cross-process lock, so concurrent server starts
 * perform at most one login between them.
 */
export async function withLoginLock<T>(fn: () => Promise<T>, path = getTokenCachePath()): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });

  let logged = false;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // Can't lock (read-only home, etc.) - proceed unlocked rather than fail.
        return fn();
      }
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // Lock vanished between open and stat; retry.
      }
      if (!logged) {
        console.error("[auth] Another Skylight server is logging in; waiting for it...");
        logged = true;
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
